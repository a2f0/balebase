import { describe, expect, it } from "bun:test";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import {
  assignAcceptedInvitationRequirements,
  assignRenewedInvitationRequirements,
} from "./employeeForms";
import {
  createFixture,
  createRequirement,
  jsonPost,
  now,
  orgId,
} from "./testing/employeeFormFixture";
import { streamedUpload } from "./testing/http";

describe("employee forms", () => {
  it("assigns invitation requirements and transfers them to the member", async () => {
    const fixture = await createFixture();
    const created = await fixture.app("owner", "owner").request("/", {
      body: JSON.stringify({
        invitationId: "invite",
        requirements: [
          { kind: "form", title: "W-4", dueDate: "2026-10-01" },
          {
            kind: "background_check",
            title: "Background check",
            dueDate: "2026-10-05",
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const { ids } = (await created.json()) as { ids: string[] };
    expect(ids).toHaveLength(2);

    const before = await fixture.app("employee", "member").request("/");
    expect((await before.json()) as { requirements: unknown[] }).toEqual({
      requirements: [],
    });

    fixture.database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
              VALUES ('new-member', ?, 'invitee', 'member', ?)`)
      .run(orgId, now());
    await assignAcceptedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite",
      "new-member",
    );
    const after = await fixture.app("invitee", "member").request("/");
    const body = (await after.json()) as {
      requirements: Array<{ id: string; title: string }>;
    };
    expect(body.requirements.map(({ id }) => id)).toEqual(ids);
    expect(body.requirements[0]?.title).toBe("W-4");
  });

  it("enforces organization scope, manager writes, and valid due dates", async () => {
    const fixture = await createFixture();
    const data = {
      memberId: "employee-member",
      requirements: [{ kind: "form", title: "W-9", dueDate: "2026-02-30" }],
    };
    const invalid = await fixture
      .app("owner", "owner")
      .request("/", jsonPost(data));
    expect(invalid.status).toBe(400);

    const forbidden = await fixture.app("employee", "member").request(
      "/",
      jsonPost({
        ...data,
        requirements: [{ kind: "form", title: "W-9", dueDate: "2026-10-02" }],
      }),
    );
    expect(forbidden.status).toBe(403);

    const otherOrg = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "other-member",
        requirements: [{ kind: "form", title: "W-9", dueDate: "2026-10-02" }],
      }),
    );
    expect(otherOrg.status).toBe(404);

    const malformed = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [{ kind: ["form"], title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(malformed.status).toBe(400);
    const id = await createRequirement(fixture, "form", "W-4");
    const invalidStatus = await fixture
      .app("owner", "owner")
      .request(`/${id}`, {
        body: JSON.stringify({ status: ["complete"] }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    expect(invalidStatus.status).toBe(400);
    for (const documentRevision of [{ invalid: true }, [1], null]) {
      const malformedRevision = await fixture
        .app("owner", "owner")
        .request(`/${id}`, {
          body: JSON.stringify({
            dueDate: "2026-10-10",
            documentRevision,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
      expect(malformedRevision.status).toBe(400);
    }
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const malformedCheckRevision = await fixture
      .app("owner", "owner")
      .request(`/${checkId}`, {
        body: JSON.stringify({
          status: "in_progress",
          documentRevision: { invalid: true },
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    expect(malformedCheckRevision.status).toBe(400);
  });

  it("explains why a requirement request or update is refused", async () => {
    const fixture = await createFixture();
    const owner = fixture.app("owner", "owner");
    const requirement = { kind: "form", title: "W-4", dueDate: "2026-10-02" };
    const create = async (body: unknown) => {
      const response = await owner.request("/", jsonPost(body));
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    expect(await create(null)).toBe("A target and requirements are required.");
    for (const target of [
      {},
      { invitationId: "invite", memberId: "employee-member" },
      { memberId: 7 },
    ]) {
      expect(await create({ ...target, requirements: [requirement] })).toBe(
        "Choose one member or invitation.",
      );
    }
    for (const requirements of [
      [],
      Array.from({ length: 21 }, () => requirement),
      [{ ...requirement, kind: "tax_return" }],
      [{ ...requirement, title: "   " }],
      [{ ...requirement, title: "W".repeat(101) }],
      [{ ...requirement, dueDate: "2026-02-30" }],
      ["W-4"],
    ]) {
      expect(await create({ memberId: "employee-member", requirements })).toBe(
        "Choose 1 to 20 valid requirements.",
      );
    }

    const id = await createRequirement(fixture, "form", "W-4");
    const update = async (body: unknown) => {
      const response = await owner.request(`/${id}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    expect(await update([])).toBe("Invalid update.");
    for (const body of [
      {},
      { status: "approved" },
      { dueDate: "2026-13-01" },
      { dueDate: "2026-10-10", documentRevision: -1 },
      { dueDate: "2026-10-10", documentRevision: 1.5 },
    ]) {
      expect(await update(body)).toBe("Invalid status or due date.");
    }
  });

  it("rejects an invitation accepted during requirement assignment", async () => {
    const fixture = await createFixture();
    fixture.hooks.before("INSERT INTO employee_requirements", () => {
      fixture.database
        .query("UPDATE invitation SET status = 'accepted' WHERE id = 'invite'")
        .run();
    });
    const response = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(response.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM employee_requirements")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains requirements when an invitation is renewed", async () => {
    const fixture = await createFixture();
    const response = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(response.status).toBe(201);
    fixture.database
      .query("UPDATE invitation SET status = 'canceled' WHERE id = 'invite'")
      .run();
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('invite-2', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
      .run(orgId, "2026-10-05", now());
    await assignRenewedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite-2",
      "invitee@example.com",
    );
    expect(
      fixture.database
        .query("SELECT invitation_id FROM employee_requirements")
        .get(),
    ).toEqual({ invitation_id: "invite-2" });
    fixture.database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
              VALUES ('new-member', ?, 'invitee', 'member', ?)`)
      .run(orgId, now());
    await assignAcceptedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite-2",
      "new-member",
    );
    expect(
      fixture.database
        .query("SELECT invitation_id, member_id FROM employee_requirements")
        .get(),
    ).toEqual({ invitation_id: null, member_id: "new-member" });
  });

  it("transfers requirements when a pending invitation has expired", async () => {
    const fixture = await createFixture();
    const assigned = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [{ kind: "form", title: "W-4", dueDate: "2026-10-02" }],
      }),
    );
    expect(assigned.status).toBe(201);
    fixture.database
      .query("UPDATE invitation SET expiresAt = ? WHERE id = 'invite'")
      .run(new Date(Date.now() - 60_000).toISOString());
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('invite-2', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
      .run(orgId, new Date(Date.now() + 86_400_000).toISOString(), now());
    await assignRenewedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "invite-2",
      "invitee@example.com",
    );
    expect(
      fixture.database
        .query("SELECT invitation_id FROM employee_requirements")
        .get(),
    ).toEqual({ invitation_id: "invite-2" });
  });

  it("preserves concurrent status and rejects review of a replaced form", async () => {
    const fixture = await createFixture();
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.beforeRun("SET status = COALESCE", () => {
      fixture.database
        .query(
          "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
        )
        .run(checkId);
    });
    const dueDate = await fixture.app("owner", "owner").request(`/${checkId}`, {
      body: JSON.stringify({ dueDate: "2026-10-10" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(dueDate.status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT status, due_date FROM employee_requirements WHERE id = ?",
        )
        .get(checkId),
    ).toEqual({ status: "complete", due_date: "2026-10-10" });

    const formId = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set("file", new File(["old"], "old.pdf", { type: "application/pdf" }));
    await fixture.app("employee", "member").request(`/${formId}/document`, {
      body: form,
      method: "POST",
    });
    fixture.beforeRun("SET status = COALESCE", () => {
      fixture.database
        .query(
          "UPDATE employee_requirements SET document_key = 'new-key', document_revision = document_revision + 1 WHERE id = ?",
        )
        .run(formId);
    });
    const review = await fixture.app("owner", "owner").request(`/${formId}`, {
      body: JSON.stringify({ status: "complete", documentRevision: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(review.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(formId),
    ).toEqual({ status: "submitted" });
  });

  it("blocks manual completion while a Checkr start is unresolved", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(
        "UPDATE employee_requirements SET checkr_start_nonce = 'pending' WHERE id = ?",
      )
      .run(id);
    const pending = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(pending.status).toBe(400);
    const dueDate = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ dueDate: "2026-10-10" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(dueDate.status).toBe(200);

    fixture.database
      .query(
        "UPDATE employee_requirements SET checkr_start_nonce = NULL WHERE id = ?",
      )
      .run(id);
    fixture.beforeRun("SET status = COALESCE", () => {
      fixture.database
        .query(
          "UPDATE employee_requirements SET checkr_start_nonce = 'raced' WHERE id = ?",
        )
        .run(id);
    });
    const raced = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(raced.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "pending" });
  });

  it("keeps submitted documents private and requires review before completion", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const noFile = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(noFile.status).toBe(400);

    const form = new FormData();
    form.set(
      "file",
      new File(["form contents"], "tax.pdf", { type: "application/pdf" }),
    );
    const upload = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, {
        body: form,
        method: "POST",
      });
    expect(upload.status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM deleted_object_cleanup WHERE id LIKE 'employee-form-upload:%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const unrelated = await fixture
      .app("owner", "member")
      .request(`/${id}/document`);
    expect(unrelated.status).toBe(404);
    const download = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("form contents");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    const downloadedRevision = Number(
      download.headers.get("x-document-revision"),
    );
    expect(downloadedRevision).toBe(1);

    const replacement = new FormData();
    replacement.set(
      "file",
      new File(["updated form"], "updated.pdf", { type: "application/pdf" }),
    );
    const replaced = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: replacement, method: "POST" });
    expect(replaced.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });

    const staleReview = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({
        status: "complete",
        documentRevision: downloadedRevision,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(staleReview.status).toBe(409);

    const latestDownload = await fixture
      .app("owner", "owner")
      .request(`/${id}/document`);
    expect(await latestDownload.text()).toBe("updated form");
    const latestRevision = Number(
      latestDownload.headers.get("x-document-revision"),
    );
    expect(latestRevision).toBe(2);

    const reviewed = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({
        status: "complete",
        documentRevision: latestRevision,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(reviewed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "complete" });
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    const formerMember = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(formerMember.status).toBe(404);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("escapes the document's name in its download header", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set(
      "file",
      new File(["form contents"], "Dana's W-4 (final).pdf", {
        type: "application/pdf",
      }),
    );
    const upload = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(upload.status).toBe(200);
    const download = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="document"; filename*=UTF-8''Dana%27s%20W-4%20(final).pdf`,
    );
  });

  it("purges an uploaded form after an interrupted request", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.storageState.failPutAfterWrite = true;
    fixture.storageState.failDelete = true;
    const form = new FormData();
    form.set(
      "file",
      new File(["private"], "tax.pdf", { type: "application/pdf" }),
    );
    const failed = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(failed.status).toBe(500);
    expect(fixture.files.size).toBe(1);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
    fixture.storageState.failDelete = false;
    await purgeDeletedObjects(fixture.bindings, {
      abandonedClaimedBefore: new Date(Date.now() + 60_000).toISOString(),
      deletedBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(fixture.files.size).toBe(0);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps a form when the database commits but its response is lost", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.hooks.after(
      "SET document_key = ?",
      () => {
        throw new Error("D1 response lost.");
      },
      { method: "run" },
    );
    const form = new FormData();
    form.set(
      "file",
      new File(["saved form"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(200);
    expect(fixture.files.size).toBe(1);
    const downloaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`);
    expect(await downloaded.text()).toBe("saved form");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("does not link a form after cleanup claims its upload", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    fixture.beforeRun("SET document_key = ?", () => {
      fixture.database
        .query(
          "UPDATE deleted_object_cleanup SET cleanup_token = 'worker' WHERE id LIKE 'employee-form-upload:%'",
        )
        .run();
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["stale"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(409);
    expect(
      fixture.database
        .query("SELECT document_key FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ document_key: null });
  });

  it("rejects oversized multipart uploads before parsing them", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf", {
        type: "application/pdf",
      }),
    );
    const upload = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(upload.status).toBe(413);
    expect(fixture.files.size).toBe(0);
  });

  it("refuses an oversized document while it streams", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const fileBytes = 32 * 1024 * 1024;
    const upload = streamedUpload(fileBytes);
    const response = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, {
        body: upload.body,
        headers: upload.headers,
        method: "POST",
      });
    expect(response.status).toBe(413);
    expect(upload.progress.cancelled).toBe(true);
    expect(upload.progress.sentBytes).toBeLessThan(fileBytes);
    expect(fixture.files.size).toBe(0);
  });

  it("retains active screenings after a membership is removed", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_report_id = 'active-check', checkr_report_status = 'pending'
              WHERE id = ?`)
      .run(id);
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    expect(
      fixture.database
        .query(
          "SELECT member_id, target_email, checkr_report_id FROM employee_requirements WHERE id = ?",
        )
        .get(id),
    ).toEqual({
      member_id: null,
      target_email: "employee@example.com",
      checkr_report_id: "active-check",
    });
    const removal = await fixture.app("owner", "owner").request(`/${id}`, {
      method: "DELETE",
    });
    expect(removal.status).toBe(409);
  });

  it("allows manual completion after a Checkr report is canceled", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_report_id = 'canceled-check',
                  checkr_report_status = 'canceled' WHERE id = ?`)
      .run(id);
    const completed = await fixture.app("owner", "owner").request(`/${id}`, {
      body: JSON.stringify({ status: "complete" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(completed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT status FROM employee_requirements WHERE id = ?")
        .get(id),
    ).toEqual({ status: "complete" });
  });

  it("does not transfer a former member's forms to a reused email", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    const form = new FormData();
    form.set(
      "file",
      new File(["private tax form"], "tax.pdf", { type: "application/pdf" }),
    );
    const uploaded = await fixture
      .app("employee", "member")
      .request(`/${id}/document`, { body: form, method: "POST" });
    expect(uploaded.status).toBe(200);
    fixture.database
      .query("DELETE FROM member WHERE id = 'employee-member'")
      .run();
    fixture.database
      .query(`INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
        VALUES ('replacement-invite', ?, 'employee@example.com', 'member',
                'pending', ?, ?, 'owner')`)
      .run(orgId, "2026-10-05", now());
    await assignRenewedInvitationRequirements(
      fixture.bindings.DB,
      orgId,
      "replacement-invite",
      "employee@example.com",
    );
    expect(
      fixture.database
        .query(
          "SELECT invitation_id, assigned_user_id FROM employee_requirements WHERE id = ?",
        )
        .get(id),
    ).toEqual({ invitation_id: null, assigned_user_id: "employee" });
  });

  it("lists a manager's own requests, as the person sees them, for My documents", async () => {
    const fixture = await createFixture();
    const employees = await createRequirement(fixture, "form", "W-4");
    const created = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "member_owner",
        requirements: [
          { dueDate: "2026-10-01", kind: "background_check", title: "Own" },
        ],
      }),
    );
    const own =
      ((await created.json()) as { ids: string[] }).ids[0] ?? "missing";
    fixture.database
      .query(
        `UPDATE employee_requirements
         SET checkr_report_id = 'report', checkr_report_status = 'complete',
             checkr_result = 'clear', status = 'complete'
         WHERE id = ?`,
      )
      .run(own);
    const list = async (path: string, user = "owner", role = "owner") =>
      (
        (await (await fixture.app(user, role).request(path)).json()) as {
          requirements: Array<{ checkrResult: string | null; id: string }>;
        }
      ).requirements;

    expect((await list("/")).map(({ id }) => id).sort()).toEqual(
      [employees, own].sort(),
    );
    expect((await list("/")).find(({ id }) => id === own)?.checkrResult).toBe(
      "clear",
    );
    expect(await list("/?for=me")).toEqual([
      expect.objectContaining({ checkrResult: null, id: own }),
    ]);
    expect(
      (await list("/?for=me", "employee", "member")).map(({ id }) => id),
    ).toEqual([employees]);
  });
});
