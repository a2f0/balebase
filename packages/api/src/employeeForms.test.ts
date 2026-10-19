import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { verifyCheckrWebhook } from "./checkr";
import { recoverCheckrAttempt } from "./checkrScreening";
import {
  handleCheckrWebhook,
  refreshActiveCheckrScreenings,
} from "./checkrSync";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import {
  assignAcceptedInvitationRequirements,
  assignRenewedInvitationRequirements,
  employeeForms,
} from "./employeeForms";
import {
  disclosureFingerprint,
  screeningDisclosures,
  screeningDisclosureVersion,
  summaryOfRightsUrl,
} from "./screeningDisclosures";
import type { Bindings } from "./types";

const orgId = "org_owner";

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

  it("rejects an invitation accepted during requirement assignment", async () => {
    const fixture = await createFixture();
    fixture.beforeBatch(() => {
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
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
          )
          .run(checkId);
      }
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
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET document_key = 'new-key', document_revision = document_revision + 1 WHERE id = ?",
          )
          .run(formId);
      }
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
    fixture.beforeRun((query) => {
      if (query.includes("SET status = COALESCE")) {
        fixture.database
          .query(
            "UPDATE employee_requirements SET checkr_start_nonce = 'raced' WHERE id = ?",
          )
          .run(id);
      }
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
    fixture.afterRun(() => {
      throw new Error("D1 response lost.");
    });
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
    fixture.beforeDocumentUpdate(() => {
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

  it("requests a background check at a work location and emails the person", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const credit = await createRequirement(fixture, "credit_check", "Credit");
    const request = (
      requirementId: string,
      body: unknown,
      user = "owner",
      role = "owner",
    ) =>
      fixture
        .app(user, role)
        .request(`/${requirementId}/checkr/request`, jsonPost(body));

    expect(
      (await request(id, { state: "CA" }, "employee", "member")).status,
    ).toBe(403);
    expect((await request(id, { state: "ZZ" })).status).toBe(400);
    expect((await request(credit, { state: "CA" })).status).toBe(404);
    delete fixture.bindings.CHECKR_BACKGROUND_PACKAGE;
    expect((await request(id, { state: "CA" })).status).toBe(503);
    configureCheckr(fixture);

    const requested = await request(id, { city: " San Jose ", state: "CA" });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ emailed: true });
    expect(fixture.emails).toHaveLength(1);
    expect(fixture.emails[0]?.to.email).toBe("employee@example.com");
    expect(fixture.emails[0]?.subject).toBe(
      "Acme requested a background check",
    );
    expect(fixture.emails[0]?.text).toContain(
      `https://app.balebase.test/organization/people/employee-member/screening/${id}?organization=${orgId}`,
    );
    const listed = (await (
      await fixture.app("employee", "member").request("/")
    ).json()) as { requirements: Array<{ id: string }> };
    expect(listed.requirements.find((item) => item.id === id)).toMatchObject({
      canSubmitCheckr: true,
      checkrAvailable: true,
      checkrReportStatus: null,
      checkrRequested: true,
      checkrResult: null,
      checkrWorkLocation: { city: "San Jose", state: "CA" },
    });
    expect(
      listed.requirements.find((item) => item.id === credit),
    ).toMatchObject({ checkrAvailable: false, checkrRequested: false });
    const managed = (await (
      await fixture.app("owner", "owner").request("/")
    ).json()) as { requirements: Array<{ id: string }> };
    expect(managed.requirements.find((item) => item.id === id)).toMatchObject({
      canSubmitCheckr: false,
      checkrRequested: true,
    });

    const invited = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [
          { dueDate: "2026-10-01", kind: "background_check", title: "Check" },
        ],
      }),
    );
    const [invitedId] = ((await invited.json()) as { ids: string[] }).ids;
    expect((await request(invitedId ?? "", { state: "NY" })).status).toBe(200);
    expect(fixture.emails[1]?.to.email).toBe("invitee@example.com");
    expect(fixture.emails[1]?.text).toContain("Accept your invitation to Acme");
  });

  it("serves the screening form only to the person, with test candidates in staging", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) =>
      call.url.startsWith("/packages")
        ? Response.json({
            data: [
              { screenings: [{ type: "ssn_trace" }], slug: "other_package" },
              {
                screenings: [
                  { type: "ssn_trace" },
                  { type: "motor_vehicle_report" },
                ],
                slug: "background_package",
              },
            ],
          })
        : Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      const managerView = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/form`);
      expect(managerView.status).toBe(404);
      const form = await fixture
        .app("employee", "member")
        .request(`/${id}/checkr/form`);
      expect(form.status).toBe(200);
      const body = (await form.json()) as {
        disclosures: { stateNotices: Record<string, unknown>; version: string };
        testCandidates: Array<{ expectedResult: string; id: string }> | null;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        candidate: { email: "employee@example.com", name: "employee" },
        organizationName: "Acme",
        requiresDriverLicense: true,
        summaryOfRightsUrl,
        title: "Background check",
        workLocation: { city: "San Jose", state: "CA" },
      });
      expect(body.disclosures.version).toBe(screeningDisclosureVersion);
      expect(Object.keys(body.disclosures.stateNotices)).toContain("CA");
      expect(body.testCandidates).toHaveLength(6);
      expect(body.testCandidates?.[0]).toMatchObject({
        expectedResult: "clear",
        id: "homer-simpson",
      });

      fixture.bindings.CHECKR_ENV = "production";
      checkr.respond = () =>
        Response.json({ error: "unavailable" }, { status: 503 });
      const production = (await (
        await fixture.app("employee", "member").request(`/${id}/checkr/form`)
      ).json()) as { requiresDriverLicense: boolean; testCandidates: unknown };
      expect(production.testCandidates).toBeNull();
      expect(production.requiresDriverLicense).toBe(false);
    } finally {
      checkr.restore();
    }
  });

  it("orders a report with the person's details and signed authorization", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const submitted = await submitScreening(fixture, id, homerSubmission());
      expect(submitted.status).toBe(200);
      expect(await submitted.json()).toEqual({ status: "pending" });
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "POST /candidates",
          "POST /candidates/candidate-1/documents",
          "POST /reports",
        ],
      );
      const [candidateCall, documentCall, reportCall] = checkr.calls;
      const candidate = new URLSearchParams(String(candidateCall?.body));
      expect(Object.fromEntries(candidate)).toEqual({
        copy_requested: "true",
        custom_id: id,
        dob: "1983-02-10",
        driver_license_number: "M2233344",
        driver_license_state: "CA",
        email: "employee@example.com",
        first_name: "Homer",
        last_name: "Simpson",
        no_middle_name: "true",
        ssn: "110-11-1100",
        zipcode: "94088",
      });
      const nonce = candidateCall?.idempotencyKey?.replace(/:candidate$/, "");
      expect(nonce).toEqual(expect.any(String));
      expect(documentCall?.idempotencyKey).toStartWith(`${nonce}:consent:`);
      expect(reportCall?.idempotencyKey).toBe(`${nonce}:report`);
      const document = documentCall?.body as FormData;
      expect(document.get("type")).toBe("consent");
      expect((document.get("file") as File).type).toBe("application/pdf");
      expect(
        Object.fromEntries(new URLSearchParams(String(reportCall?.body))),
      ).toEqual({
        candidate_id: "candidate-1",
        package: "background_package",
        "work_locations[][city]": "San Jose",
        "work_locations[][country]": "US",
        "work_locations[][state]": "CA",
      });

      const requirement = fixture.database
        .query(`SELECT status, checkr_candidate_id, checkr_report_id,
                       checkr_report_status, checkr_consent_id,
                       checkr_start_nonce
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_consent_id: string };
      expect(requirement).toMatchObject({
        checkr_candidate_id: "candidate-1",
        checkr_report_id: "report-1",
        checkr_report_status: "pending",
        checkr_start_nonce: null,
        status: "in_progress",
      });
      const consent = fixture.database
        .query("SELECT * FROM employee_screening_consents")
        .get() as { document_key: string };
      expect(consent).toMatchObject({
        copy_requested: 1,
        disclosure_version: screeningDisclosureVersion,
        id: requirement.checkr_consent_id,
        ip_address: "203.0.113.7",
        requirement_id: id,
        signature_name: "Homer Simpson",
        state_notices: '["CA"]',
        user_agent: "Test browser",
        user_id: "employee",
      });
      const stored = JSON.stringify([
        fixture.database.query("SELECT * FROM employee_requirements").all(),
        fixture.database
          .query("SELECT * FROM employee_screening_consents")
          .all(),
      ]);
      expect(stored).not.toContain("110-11-1100");
      expect(stored).not.toContain("1983-02-10");
      const pdf = fixture.files.get(String(consent.document_key));
      expect(
        new TextDecoder().decode((await pdf?.arrayBuffer())?.slice(0, 5)),
      ).toBe("%PDF-");

      for (const [user, role, status] of [
        ["employee", "member", 200],
        ["owner", "owner", 200],
        ["invitee", "member", 404],
      ] as const) {
        const download = await fixture
          .app(user, role)
          .request(`/${id}/checkr/consent`);
        expect(download.status).toBe(status);
      }

      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(409);
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${id}`, { method: "DELETE" })
        ).status,
      ).toBe(409);
      const manual = await fixture.app("owner", "owner").request(`/${id}`, {
        body: JSON.stringify({ status: "complete" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      expect(manual.status).toBe(400);
      const ownView = (await (
        await fixture.app("employee", "member").request("/")
      ).json()) as { requirements: Array<Record<string, unknown>> };
      expect(ownView.requirements[0]).toMatchObject({
        checkrReportStatus: "pending",
        checkrRequested: false,
        checkrResult: null,
        hasCheckrConsent: true,
      });

      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(await refreshed.json()).toEqual({
        reportStatus: "complete",
        result: "clear",
      });
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_result: "clear", status: "complete" });
      const hidden = (await (
        await fixture.app("employee", "member").request("/")
      ).json()) as { requirements: Array<{ checkrResult: string | null }> };
      expect(hidden.requirements[0]?.checkrResult).toBeNull();
    } finally {
      checkr.restore();
    }
  });

  it("checks acknowledgments and details before contacting Checkr", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const unrequested = await createRequirement(
      fixture,
      "background_check",
      "Not requested",
    );
    const checkr = mockCheckr(checkrResponses);
    try {
      const valid = homerSubmission();
      const cases: Array<[unknown, string]> = [
        [
          { ...valid, disclosureFingerprint: "stale" },
          "These disclosures changed after you opened the form. Reload the page to review the current version.",
        ],
        [
          {
            ...valid,
            acknowledgments: {
              ...valid.acknowledgments,
              summaryOfRights: false,
            },
          },
          "Acknowledge the summary of your rights and the disclosure before submitting.",
        ],
        [
          {
            ...valid,
            acknowledgments: { ...valid.acknowledgments, stateNotices: [] },
          },
          "Acknowledge each state notice before submitting.",
        ],
        [
          { ...valid, residenceState: "NY" },
          "Acknowledge each state notice before submitting.",
        ],
        [
          { ...valid, signature: { ...valid.signature, name: "Someone Else" } },
          "Type your full legal name to sign.",
        ],
        [
          {
            ...valid,
            signature: { ...valid.signature, electronicRecords: false },
          },
          "Agree to sign electronically and authorize the background check to submit.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, ssn: "12345" } },
          "Enter a 9-digit Social Security number.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, dob: "2999-01-01" } },
          "Enter a valid date of birth.",
        ],
        [
          {
            ...valid,
            candidate: { ...valid.candidate, driverLicenseState: "" },
          },
          "Enter both your driver's license number and its state, or leave both blank.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, noMiddleName: false } },
          "Enter your legal first and last name, and your middle name or that you have none. Checkr accepts letters A–Z and accented letters such as é or ñ.",
        ],
      ];
      for (const [body, error] of cases) {
        const response = await submitScreening(fixture, id, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
      }
      expect(
        (await submitScreening(fixture, id, valid, "owner", "owner")).status,
      ).toBe(404);
      expect((await submitScreening(fixture, unrequested, valid)).status).toBe(
        409,
      );
      const stale = await submitScreening(fixture, id, {
        ...valid,
        requestRevision: "2026-01-01T00:00:00.000Z",
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error:
          "This background check changed after you opened it. Reload the page to review it again.",
      });
      expect(checkr.calls).toEqual([]);
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("clears an attempt Checkr rejects so the person can correct it", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let reject: "candidate" | "report" | null = "candidate";
    let candidates = 0;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        if (reject === "candidate") {
          return Response.json({ error: "Ssn is invalid" }, { status: 400 });
        }
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.method === "POST" && call.url === "/reports" && reject) {
        return Response.json(
          { error: ["Driver license number is required"] },
          { status: 422 },
        );
      }
      return checkrResponses(call);
    });
    try {
      const rejected = await submitScreening(fixture, id, homerSubmission());
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toEqual({
        error: "Checkr couldn't accept these details: Ssn is invalid",
      });
      const cleared = () =>
        fixture.database
          .query(`SELECT checkr_start_nonce, checkr_candidate_id, status
                  FROM employee_requirements WHERE id = ?`)
          .get(id);
      expect(cleared()).toEqual({
        checkr_candidate_id: null,
        checkr_start_nonce: null,
        status: "pending",
      });

      reject = "report";
      const missingLicense = await submitScreening(
        fixture,
        id,
        homerSubmission(),
      );
      expect(missingLicense.status).toBe(422);
      expect(await missingLicense.json()).toEqual({
        error:
          "Checkr couldn't accept these details: Driver license number is required",
      });
      expect(cleared()).toEqual({
        checkr_candidate_id: null,
        checkr_start_nonce: null,
        status: "pending",
      });

      reject = null;
      const corrected = await submitScreening(fixture, id, homerSubmission());
      expect(corrected.status).toBe(200);
      const candidateKeys = checkr.calls
        .filter(({ method, url }) => method === "POST" && url === "/candidates")
        .map(({ idempotencyKey }) => idempotencyKey);
      expect(new Set(candidateKeys).size).toBe(3);
      expect(
        fixture.database
          .query(
            "SELECT checkr_candidate_id, checkr_report_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_candidate_id: "candidate-2",
        checkr_report_id: "report-1",
      });
      // Each signed attempt keeps its authorization record.
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      checkr.restore();
    }
  });

  it("resumes a lost submission without ordering a second report", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let reportOrdered = false;
    let failUpload = true;
    const checkr = mockCheckr((call) => {
      if (call.url === "/candidates/candidate-1/documents" && failUpload) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (call.method === "POST" && call.url === "/reports") {
        reportOrdered = true;
        throw new TypeError("Network connection lost.");
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          id: "candidate-1",
          report_ids: reportOrdered ? ["report-1"] : [],
        });
      }
      if (call.url === "/reports/report-1") {
        return Response.json({
          id: "report-1",
          result: null,
          status: "pending",
        });
      }
      return checkrResponses(call);
    });
    try {
      const unavailable = await submitScreening(fixture, id, homerSubmission());
      expect(unavailable.status).toBe(502);
      const kept = fixture.database
        .query(`SELECT checkr_start_nonce, checkr_candidate_id,
                       checkr_starting_at
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_start_nonce: string | null };
      expect(kept).toMatchObject({
        checkr_candidate_id: "candidate-1",
        checkr_starting_at: null,
      });
      expect(checkr.calls[0]?.idempotencyKey).toBe(
        `${kept.checkr_start_nonce}:candidate`,
      );

      failUpload = false;
      checkr.calls.length = 0;
      const lost = await submitScreening(fixture, id, homerSubmission());
      expect(lost.status).toBe(500);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "GET /candidates/candidate-1",
          "POST /candidates/candidate-1/documents",
          "POST /reports",
        ],
      );
      expect(checkr.calls[2]?.idempotencyKey).toBe(
        `${kept.checkr_start_nonce}:report`,
      );
      const uploaded = checkr.calls[1]?.idempotencyKey?.split(":consent:")[1];

      checkr.calls.length = 0;
      const resumed = await submitScreening(fixture, id, {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "999-99-9999" },
      });
      expect(resumed.status).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1", "GET /reports/report-1"],
      );
      // The adopted report keeps the authorization that ordered it.
      expect(
        fixture.database
          .query(`SELECT checkr_report_id, checkr_consent_id,
                         checkr_start_nonce, status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_consent_id: uploaded,
        checkr_report_id: "report-1",
        checkr_start_nonce: null,
        status: "in_progress",
      });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      checkr.restore();
    }
  });

  it("starts a new candidate when the person corrects details after a failed attempt", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let candidates = 0;
    let uploadAvailable = false;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          dob: "1983-02-10",
          first_name: "Homer",
          id: "candidate-1",
          last_name: "Simpson",
          report_ids: [],
          ssn: "XXX-XX-1100",
          zipcode: "94088",
        });
      }
      if (call.url.endsWith("/documents") && !uploadAvailable) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return checkrResponses(call);
    });
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(502);
      uploadAvailable = true;
      checkr.calls.length = 0;
      const corrected = {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
      };
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "GET /candidates/candidate-1",
          "POST /candidates",
          "POST /candidates/candidate-2/documents",
          "POST /reports",
        ],
      );
      expect(
        new URLSearchParams(String(checkr.calls[1]?.body)).get("ssn"),
      ).toBe("111-11-1100");
      expect(
        fixture.database
          .query(
            "SELECT checkr_candidate_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_candidate_id: "candidate-2" });
    } finally {
      checkr.restore();
    }
  });

  it("asks the person to wait while a lost report request may still reach Checkr", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let candidates = 0;
    let reportLost = true;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          first_name: "Homer",
          id: "candidate-1",
          report_ids: [],
          ssn: "XXX-XX-1100",
        });
      }
      if (call.method === "POST" && call.url === "/reports" && reportLost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    const corrected = {
      ...homerSubmission(),
      candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
    };
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      checkr.calls.length = 0;
      const early = await submitScreening(fixture, id, corrected);
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual({
        error:
          "Your earlier submission may still be reaching Checkr. Wait a few minutes, then submit again.",
      });
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1"],
      );

      reportLost = false;
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_report_requested_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(id);
      checkr.calls.length = 0;
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      expect(
        checkr.calls
          .filter(({ method }) => method === "POST")
          .map(({ url }) => url),
      ).toEqual([
        "/candidates",
        "/candidates/candidate-2/documents",
        "/reports",
      ]);
    } finally {
      checkr.restore();
    }
  });

  it("queues a consent PDF for cleanup until its record exists", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      fixture.storageState.failPutAfterWrite = true;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [stored] = [...fixture.files.keys()];
      expect(stored).toContain("/screening-consents/");
      expect(
        fixture.database
          .query("SELECT object_key FROM deleted_object_cleanup")
          .all(),
      ).toEqual([{ object_key: stored }]);
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 0 });
      expect(checkr.calls).toEqual([]);

      fixture.storageState.failPutAfterWrite = false;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(200);
      const consent = fixture.database
        .query("SELECT document_key FROM employee_screening_consents")
        .get() as { document_key: string };
      expect(
        fixture.database
          .query(
            "SELECT COUNT(*) AS count FROM deleted_object_cleanup WHERE object_key = ?",
          )
          .get(consent.document_key),
      ).toEqual({ count: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("does not replay a lost candidate request with corrected details", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let lost = true;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates" && lost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    const candidateKeys = () =>
      checkr.calls
        .filter(({ method, url }) => method === "POST" && url === "/candidates")
        .map(({ idempotencyKey }) => idempotencyKey);
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [first, replayed] = candidateKeys();
      expect(replayed).toBe(first);

      lost = false;
      const corrected = {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
      };
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      const keys = candidateKeys();
      expect(keys).toHaveLength(3);
      expect(keys[2]).not.toBe(first);
      const created = checkr.calls.filter(
        ({ method, url }) => method === "POST" && url === "/candidates",
      )[2];
      expect(new URLSearchParams(String(created?.body)).get("ssn")).toBe(
        "111-11-1100",
      );
    } finally {
      checkr.restore();
    }
  });

  it("replays a lost report request without attaching a newer authorization", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let lost = true;
    const checkr = mockCheckr((call) => {
      if (call.url === "/candidates/candidate-1") {
        return Response.json({ id: "candidate-1", report_ids: [] });
      }
      if (call.method === "POST" && call.url === "/reports" && lost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [, upload, firstReport] = checkr.calls;
      const authorization = upload?.idempotencyKey?.split(":consent:")[1];
      // Even a day later, the replay keeps the report request's key.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(id);
      lost = false;
      checkr.calls.length = 0;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1", "POST /reports"],
      );
      expect(checkr.calls[1]?.idempotencyKey).toBe(
        firstReport?.idempotencyKey ?? "",
      );
      expect(
        fixture.database
          .query(
            "SELECT checkr_consent_id, checkr_report_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_consent_id: authorization,
        checkr_report_id: "report-1",
      });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      checkr.restore();
    }
  });

  it("settles an unfinished submission after its person leaves", async () => {
    const fixture = await createFixture();
    const adopted = await requestedScreening(fixture);
    const abandoned = await createRequirement(
      fixture,
      "background_check",
      "Abandoned check",
    );
    await fixture
      .app("owner", "owner")
      .request(`/${abandoned}/checkr/request`, jsonPost({ state: "CA" }));
    let reportCreated = false;
    let failUpload = false;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        return Response.json({
          id: failUpload ? "candidate-2" : "candidate-1",
        });
      }
      if (call.url.endsWith("/documents") && failUpload) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (call.method === "POST" && call.url === "/reports") {
        reportCreated = true;
        throw new TypeError("Network connection lost.");
      }
      if (call.url.startsWith("/candidates/")) {
        return Response.json({
          id: call.url.split("/")[2],
          report_ids:
            call.url === "/candidates/candidate-1" && reportCreated
              ? ["report-1"]
              : [],
        });
      }
      return Response.json({ id: "report-1", result: null, status: "pending" });
    });
    try {
      expect(
        (await submitScreening(fixture, adopted, homerSubmission())).status,
      ).toBe(500);
      failUpload = true;
      expect(
        (await submitScreening(fixture, abandoned, homerSubmission())).status,
      ).toBe(502);
      fixture.database
        .query("DELETE FROM member WHERE id = 'employee-member'")
        .run();
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${abandoned}`, { method: "DELETE" })
        ).status,
      ).toBe(409);

      // A report event for the candidate adopts its report at once.
      const event = await checkrWebhook(fixture.bindings, {
        data: {
          object: {
            candidate_id: "candidate-1",
            id: "report-1",
            object: "report",
          },
        },
        type: "report.created",
      });
      expect(event.status).toBe(200);
      const consent = fixture.database
        .query(
          "SELECT id FROM employee_screening_consents WHERE requirement_id = ?",
        )
        .get(adopted) as { id: string };
      expect(
        fixture.database
          .query(`SELECT checkr_report_id, checkr_consent_id, checkr_start_nonce
                  FROM employee_requirements WHERE id = ?`)
          .get(adopted),
      ).toEqual({
        checkr_consent_id: consent.id,
        checkr_report_id: "report-1",
        checkr_start_nonce: null,
      });

      // The hourly job clears an attempt that never reached a report.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(abandoned);
      await refreshActiveCheckrScreenings(fixture.bindings);
      expect(
        fixture.database
          .query(`SELECT checkr_start_nonce, checkr_candidate_id
                  FROM employee_requirements WHERE id = ?`)
          .get(abandoned),
      ).toEqual({ checkr_candidate_id: null, checkr_start_nonce: null });
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${abandoned}`, { method: "DELETE" })
        ).status,
      ).toBe(200);
    } finally {
      checkr.restore();
    }
  });

  it("keeps an attempt when Checkr refuses access instead of the details", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let failure: { status: number; url: string } = {
      status: 503,
      url: "/candidates/candidate-1/documents",
    };
    const checkr = mockCheckr((call) =>
      call.url === failure.url
        ? Response.json({ error: "Not allowed" }, { status: failure.status })
        : call.url === "/candidates/candidate-1"
          ? Response.json({ id: "candidate-1", report_ids: [] })
          : checkrResponses(call),
    );
    const attempt = () =>
      fixture.database
        .query(`SELECT checkr_candidate_id, checkr_start_nonce IS NOT NULL AS held
                FROM employee_requirements WHERE id = ?`)
        .get(id);
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(502);
      for (const next of [
        { status: 401, url: "/candidates/candidate-1" },
        { status: 403, url: "/reports" },
      ]) {
        failure = next;
        const response = await submitScreening(fixture, id, homerSubmission());
        expect(response.status).toBe(502);
        expect(attempt()).toEqual({
          checkr_candidate_id: "candidate-1",
          held: 1,
        });
      }
    } finally {
      checkr.restore();
    }
  });

  it("recovers an attempt as it is when claimed, not as it was read", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let report = false;
    const checkr = mockCheckr((call) =>
      call.url === "/candidates/candidate-1"
        ? Response.json({
            id: "candidate-1",
            report_ids: report ? ["report-1"] : [],
          })
        : Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    const stale = {
      checkr_attempt_consent_id: "consent-old",
      checkr_candidate_id: "candidate-1",
      checkr_report_requested_at: null,
      checkr_start_nonce: "attempt",
      id,
      organization_id: orgId,
    };
    try {
      // A retry asked for the report after the row was read.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce = 'attempt',
                    checkr_start_nonce_at = '2026-01-01T00:00:00.000Z',
                    checkr_candidate_id = 'candidate-1',
                    checkr_attempt_consent_id = 'consent-new',
                    checkr_report_requested_at = ?
                WHERE id = ?`)
        .run(new Date().toISOString(), id);
      expect(await recoverCheckrAttempt(fixture.bindings, stale)).toBe(
        "waiting",
      );
      expect(
        fixture.database
          .query(
            "SELECT checkr_start_nonce, checkr_starting_at FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_start_nonce: "attempt", checkr_starting_at: null });

      report = true;
      expect(await recoverCheckrAttempt(fixture.bindings, stale)).toBe(
        "adopted",
      );
      expect(
        fixture.database
          .query(
            "SELECT checkr_report_id, checkr_consent_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_consent_id: "consent-new",
        checkr_report_id: "report-1",
      });
    } finally {
      checkr.restore();
    }
  });

  it("does not order a check the request or membership changed under", async () => {
    for (const change of [
      "UPDATE employee_requirements SET checkr_requested_at = '2999-01-01T00:00:00.000Z', checkr_work_state = 'NV'",
      "DELETE FROM member WHERE id = 'employee-member'",
    ]) {
      const fixture = await createFixture();
      const id = await requestedScreening(fixture);
      const checkr = mockCheckr(checkrResponses);
      fixture.beforeFirst((query) => {
        if (query.includes("SET checkr_start_nonce = COALESCE")) {
          fixture.database.query(change).run();
        }
      });
      try {
        const raced = await submitScreening(fixture, id, homerSubmission());
        expect(raced.status).toBe(409);
        expect(checkr.calls).toEqual([]);
        expect(
          fixture.database
            .query(
              "SELECT checkr_start_nonce, checkr_report_id FROM employee_requirements WHERE id = ?",
            )
            .get(id),
        ).toEqual({ checkr_report_id: null, checkr_start_nonce: null });
      } finally {
        checkr.restore();
      }
    }
  });

  it("rotates attempt recovery past attempts that keep failing", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const candidates = Array.from(
      { length: 26 },
      (_, index) => `stuck-${String(index).padStart(2, "0")}`,
    );
    for (const candidate of candidates) {
      const id = await createRequirement(fixture, "background_check", "Check");
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_requested_at = ?, checkr_start_nonce = ?,
                    checkr_start_nonce_at = '2026-01-01T00:00:00.000Z',
                    checkr_candidate_id = ?
                WHERE id = ?`)
        .run(now(), `nonce-${candidate}`, candidate, id);
    }
    const attempted: string[][] = [];
    const checkr = mockCheckr((call) => {
      const candidate = /^\/candidates\/(.+)$/.exec(call.url)?.[1];
      if (candidate) attempted.at(-1)?.push(candidate);
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    try {
      for (let run = 0; run < 2; run += 1) {
        attempted.push([]);
        await expect(
          refreshActiveCheckrScreenings(fixture.bindings),
        ).rejects.toThrow();
      }
      expect(attempted[0]).toHaveLength(24);
      const skipped = candidates.filter(
        (candidate) => !attempted[0]?.includes(candidate),
      );
      expect(skipped).toHaveLength(2);
      for (const candidate of skipped) {
        expect(attempted[1]).toContain(candidate);
      }
      expect(
        fixture.database
          .query(`SELECT COUNT(*) AS held FROM employee_requirements
                  WHERE checkr_start_nonce IS NOT NULL
                    AND checkr_starting_at IS NULL`)
          .get(),
      ).toEqual({ held: 26 });
    } finally {
      checkr.restore();
    }
  });

  it("rejects a signature over wording that changed after the form loaded", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const form = (await (
        await fixture.app("employee", "member").request(`/${id}/checkr/form`)
      ).json()) as { disclosureFingerprint: string };
      fixture.database
        .query("UPDATE organization SET name = 'Acme Holdings' WHERE id = ?")
        .run(orgId);
      checkr.calls.length = 0;
      const stale = await submitScreening(fixture, id, {
        ...homerSubmission(),
        disclosureFingerprint: form.disclosureFingerprint,
      });
      expect(stale.status).toBe(400);
      expect(await stale.json()).toEqual({
        error:
          "These disclosures changed after you opened the form. Reload the page to review the current version.",
      });
      expect(checkr.calls).toEqual([]);
    } finally {
      checkr.restore();
    }
  });

  it("orders no report for a person removed while submitting", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) => {
      if (call.url.endsWith("/documents")) {
        fixture.database
          .query("DELETE FROM member WHERE id = 'employee-member'")
          .run();
      }
      return checkrResponses(call);
    });
    try {
      const response = await submitScreening(fixture, id, homerSubmission());
      expect(response.status).toBe(409);
      expect(
        checkr.calls.some(
          ({ method, url }) => method === "POST" && url === "/reports",
        ),
      ).toBe(false);
      expect(
        fixture.database
          .query(
            "SELECT checkr_report_id, checkr_report_requested_at FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_report_id: null, checkr_report_requested_at: null });
    } finally {
      checkr.restore();
    }
  });

  it("lets only the signed-in person, not a key or impersonator, open or sign their form", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const viaKey = fixture.app("employee", "member", { apiKey: true });
      const impersonated = fixture.app("employee", "member", {
        impersonatedBy: "root-admin",
      });
      for (const response of [
        await viaKey.request(`/${id}/checkr/form`),
        await viaKey.request(
          `/${id}/checkr/submit`,
          jsonPost(homerSubmission()),
        ),
        await impersonated.request(`/${id}/checkr/form`),
        await impersonated.request(
          `/${id}/checkr/submit`,
          jsonPost(homerSubmission()),
        ),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "Sign in to complete your own background check.",
        });
      }
      expect(checkr.calls).toEqual([]);
    } finally {
      checkr.restore();
    }
  });

  it("fences a submission whose claim expired out of the newer claim", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) => {
      if (call.url.endsWith("/documents")) {
        // This request is slow; its claim expires and another one takes over.
        fixture.database
          .query(`UPDATE employee_requirements
                  SET checkr_start_lease = 'newer-claim',
                      checkr_starting_at = '2999-01-01T00:00:00.000Z'
                  WHERE id = ?`)
          .run(id);
      }
      return checkrResponses(call);
    });
    try {
      const slow = await submitScreening(fixture, id, homerSubmission());
      expect(slow.status).toBe(409);
      expect(
        checkr.calls.some(
          ({ method, url }) => method === "POST" && url === "/reports",
        ),
      ).toBe(false);
      expect(
        fixture.database
          .query(`SELECT checkr_start_lease, checkr_starting_at,
                         checkr_attempt_consent_id
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_attempt_consent_id: null,
        checkr_start_lease: "newer-claim",
        checkr_starting_at: "2999-01-01T00:00:00.000Z",
      });
    } finally {
      checkr.restore();
    }
  });

  it("refreshes canceled reports and lets managers request the check again", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.database
      .query(`INSERT INTO employee_screening_consents
              (id, organization_id, requirement_id, user_id, signature_name,
               signed_at, disclosure_version, state_notices, document_key,
               created_at)
              VALUES ('consent-1', ?, ?, 'employee', 'Homer Simpson', ?, 'v',
                      '[]', 'consents/consent-1.pdf', ?)`)
      .run(orgId, id, now(), now());
    let reportResult: string | null = null;
    let reportStatus = "pending";
    const checkr = mockCheckr(() =>
      Response.json({
        id: "report-1",
        includes_canceled: true,
        result: reportResult,
        status: reportStatus,
      }),
    );
    const refresh = async () => {
      const response = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(response.status).toBe(200);
      return response.json();
    };
    const state = () =>
      fixture.database
        .query(`SELECT status, completed_at, checkr_result,
                       checkr_report_status
                FROM employee_requirements WHERE id = ?`)
        .get(id);
    try {
      expect(await refresh()).toEqual({
        reportStatus: "pending",
        result: null,
      });
      expect(state()).toEqual({
        checkr_report_status: "pending",
        checkr_result: null,
        completed_at: null,
        status: "in_progress",
      });
      reportStatus = "complete";
      expect(await refresh()).toEqual({
        reportStatus: "canceled",
        result: null,
      });
      expect(state()).toEqual({
        checkr_report_status: "canceled",
        checkr_result: null,
        completed_at: null,
        status: "pending",
      });
      reportResult = "consider";
      expect(await refresh()).toEqual({
        reportStatus: "partially_canceled",
        result: "consider",
      });

      const again = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/request`, jsonPost({ state: "NV" }));
      expect(again.status).toBe(200);
      expect(
        fixture.database
          .query(`SELECT status, checkr_report_id, checkr_report_status,
                         checkr_result, checkr_candidate_id, checkr_work_state
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_candidate_id: null,
        checkr_report_id: null,
        checkr_report_status: null,
        checkr_result: null,
        checkr_work_state: "NV",
        status: "pending",
      });
      const removed = await fixture
        .app("owner", "owner")
        .request(`/${id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT object_key FROM deleted_object_cleanup")
          .all(),
      ).toEqual([{ object_key: "consents/consent-1.pdf" }]);
    } finally {
      checkr.restore();
    }
  });

  it("keeps a completed screening when an older refresh finishes last", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.beforeRun((query) => {
      if (
        query.includes("checkr_refresh_revision = checkr_refresh_revision + 1")
      ) {
        fixture.database
          .query(`UPDATE employee_requirements
                  SET status = 'complete', checkr_result = 'clear',
                      checkr_refresh_revision = checkr_refresh_revision + 1
                  WHERE id = ?`)
          .run(id);
      }
    });
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_result: "clear", status: "complete" });
    } finally {
      checkr.restore();
    }
  });

  it("keeps manual completion when a canceled report refresh overlaps", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_report_status = 'canceled', status = 'pending'
              WHERE id = ?`)
      .run(id);
    let manualStatus = 0;
    const checkr = mockCheckr(async () => {
      if (!manualStatus) {
        manualStatus = (
          await fixture.app("owner", "owner").request(`/${id}`, {
            body: JSON.stringify({ status: "complete" }),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          })
        ).status;
      }
      return Response.json({
        id: "report-1",
        includes_canceled: true,
        result: null,
        status: "complete",
      });
    });
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(manualStatus).toBe(200);
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "complete" });
      const settled = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(settled.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "complete" });
    } finally {
      checkr.restore();
    }
  });

  it("verifies Checkr webhook signatures with Checkr's published example", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ monday: "75F", tuesday: "80F" }),
    );
    const signature =
      "b7412f05e981a473b5ecbdb5393afaea02a679db6d7c8e56803512ec4ba98151";
    expect(await verifyCheckrWebhook(payload, signature, "test-secret")).toBe(
      true,
    );
    expect(await verifyCheckrWebhook(payload, signature, "other-key")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, "not-hex", "test-secret")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, undefined, "test-secret")).toBe(
      false,
    );
  });

  it("refreshes a screening from a signed Checkr report webhook", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: "clear", status: "complete" }),
    );
    try {
      const event = {
        data: { object: { id: "report-1", object: "report" } },
        id: "event-1",
        object: "event",
        type: "report.completed",
      };
      expect(
        (await checkrWebhook(withoutCheckrKey(fixture.bindings), event)).status,
      ).toBe(503);
      expect(
        (await checkrWebhook(fixture.bindings, event, "other-key")).status,
      ).toBe(400);
      expect((await checkrWebhook(fixture.bindings, event, null)).status).toBe(
        400,
      );
      for (const type of ["invitation.completed", "candidate.created"]) {
        const ignored = await checkrWebhook(fixture.bindings, {
          data: { object: { id: "candidate-1", object: "candidate" } },
          type,
        });
        expect(ignored.status).toBe(200);
      }
      const malformed = await checkrWebhook(fixture.bindings, {
        data: {},
        type: "report.completed",
      });
      expect(malformed.status).toBe(400);
      expect(checkr.calls).toEqual([]);

      const received = await checkrWebhook(fixture.bindings, event);
      expect(received.status).toBe(200);
      expect(await received.json()).toEqual({ received: true });
      expect(checkr.calls.map(({ url }) => url)).toEqual(["/reports/report-1"]);
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_report_status,
                         checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_report_status: "complete",
        checkr_result: "clear",
        status: "complete",
      });
    } finally {
      checkr.restore();
    }
  });

  it("matches a report webhook through its candidate and retries failed refreshes", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    let checkrAvailable = true;
    const checkr = mockCheckr(() =>
      checkrAvailable
        ? Response.json({
            candidate_id: "candidate-1",
            id: "report-1",
            result: "consider",
            status: "complete",
          })
        : Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      const stranger = await checkrWebhook(fixture.bindings, {
        data: { object: { id: "stranger-report", object: "report" } },
        type: "report.completed",
      });
      expect(stranger.status).toBe(200);
      expect(checkr.calls).toEqual([]);

      checkrAvailable = false;
      const unavailable = await checkrWebhook(fixture.bindings, {
        data: {
          object: {
            candidate_id: "candidate-1",
            id: "upgraded-report",
            object: "report",
          },
        },
        type: "report.upgraded",
      });
      expect(unavailable.status).toBe(200);
      expect(checkr.calls.map(({ url }) => url)).toEqual(["/reports/report-1"]);
      const requested = fixture.database
        .query(`SELECT status, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_refresh_requested_at: string; status: string };
      expect(requested.status).toBe("in_progress");
      expect(requested.checkr_refresh_requested_at).toEqual(expect.any(String));

      checkrAvailable = true;
      expect(await refreshActiveCheckrScreenings(fixture.bindings)).toEqual({
        refreshed: 1,
        skipped: false,
      });
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_result: "consider",
        status: "complete",
      });
    } finally {
      checkr.restore();
    }
  });

  it("refreshes unfinished Checkr screenings on schedule", async () => {
    const fixture = await createFixture();
    const active = await orderedScreening(fixture);
    const failing = await orderedScreening(fixture, "report-2");
    const finished = await orderedScreening(fixture, "report-3");
    const canceled = await orderedScreening(fixture, "report-4");
    const waiting = await requestedScreening(fixture);
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
      )
      .run(finished);
    fixture.database
      .query(`UPDATE employee_requirements
              SET status = 'pending', checkr_report_status = 'canceled'
              WHERE id = ?`)
      .run(canceled);
    const checkr = mockCheckr((call) =>
      call.url === "/reports/report-2"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      expect(
        await refreshActiveCheckrScreenings(withoutCheckrKey(fixture.bindings)),
      ).toEqual({ refreshed: 0, skipped: true });
      expect(checkr.calls).toEqual([]);
      await expect(
        refreshActiveCheckrScreenings(fixture.bindings),
      ).rejects.toThrow("Could not refresh 1 Checkr screening(s).");
      expect(checkr.calls.map(({ url }) => url).toSorted()).toEqual([
        "/reports/report-1",
        "/reports/report-2",
      ]);
      const rows = fixture.database
        .query("SELECT id, checkr_refresh_revision FROM employee_requirements")
        .all() as Array<{ checkr_refresh_revision: number; id: string }>;
      const revisions = Object.fromEntries(
        rows.map((row) => [row.id, row.checkr_refresh_revision]),
      );
      expect(revisions[active]).toBe(1);
      expect(revisions[failing]).toBe(0);
      expect(revisions[finished]).toBe(0);
      expect(revisions[canceled]).toBe(0);
      expect(revisions[waiting]).toBe(1);
    } finally {
      checkr.restore();
    }
  });

  it("rotates scheduled Checkr refreshes past screenings that keep failing", async () => {
    const fixture = await createFixture();
    const reports = Array.from(
      { length: 26 },
      (_, index) => `rotating-${String(index).padStart(2, "0")}`,
    );
    for (const report of reports) await orderedScreening(fixture, report);
    const attempted: string[][] = [];
    const checkr = mockCheckr((call) => {
      const report = /\/reports\/(.+)$/.exec(call.url)?.[1];
      if (report) attempted.at(-1)?.push(report);
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    try {
      for (let run = 0; run < 2; run += 1) {
        attempted.push([]);
        await expect(
          refreshActiveCheckrScreenings(fixture.bindings),
        ).rejects.toThrow("Could not refresh 24 Checkr screening(s).");
      }
      expect(attempted[0]).toHaveLength(24);
      const skipped = reports.filter(
        (report) => !attempted[0]?.includes(report),
      );
      expect(skipped).toHaveLength(2);
      for (const report of skipped) expect(attempted[1]).toContain(report);
      expect(
        fixture.database
          .query(`SELECT COUNT(*) AS unchecked FROM employee_requirements
                  WHERE checkr_checked_at IS NULL`)
          .get(),
      ).toEqual({ unchecked: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("keeps a Checkr refresh request that a racing refresh cannot settle", async () => {
    const newer = "2999-01-01T00:00:00.000Z";
    const event = {
      data: { object: { id: "report-1", object: "report" } },
      type: "report.completed",
    };
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      const requestedDuringRefresh = await createFixture();
      const first = await orderedScreening(requestedDuringRefresh);
      beforeCheckrRefreshWrite(requestedDuringRefresh, () => {
        requestedDuringRefresh.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_requested_at = ? WHERE id = ?`)
          .run(newer, first);
      });
      expect(
        (await checkrWebhook(requestedDuringRefresh.bindings, event)).status,
      ).toBe(200);
      expect(
        requestedDuringRefresh.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(first),
      ).toEqual({
        checkr_refresh_requested_at: newer,
        checkr_refresh_revision: 1,
      });

      const reordered = await createFixture();
      const delayed = await orderedScreening(reordered);
      reordered.database
        .query(`UPDATE employee_requirements
                SET checkr_refresh_requested_at = ? WHERE id = ?`)
        .run(newer, delayed);
      expect((await checkrWebhook(reordered.bindings, event)).status).toBe(200);
      expect(
        reordered.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(delayed),
      ).toEqual({
        checkr_refresh_requested_at: newer,
        checkr_refresh_revision: 1,
      });

      const conflicted = await createFixture();
      const second = await orderedScreening(conflicted);
      beforeCheckrRefreshWrite(conflicted, () => {
        conflicted.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_revision = checkr_refresh_revision + 1
                  WHERE id = ?`)
          .run(second);
      });
      expect((await checkrWebhook(conflicted.bindings, event)).status).toBe(
        200,
      );
      const kept = conflicted.database
        .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(second) as {
        checkr_refresh_requested_at: string | null;
        checkr_refresh_revision: number;
      };
      expect(kept.checkr_refresh_revision).toBe(1);
      expect(kept.checkr_refresh_requested_at).toEqual(expect.any(String));
      expect(await refreshActiveCheckrScreenings(conflicted.bindings)).toEqual({
        refreshed: 1,
        skipped: false,
      });
      expect(
        conflicted.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(second),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_refresh_revision: 2,
      });
    } finally {
      checkr.restore();
    }
  });

  it("keeps hosted reports, stops on open invitations, and resets closed ones when migrating", async () => {
    const database = new Database(":memory:");
    await migration(database, "0003_create_auth.sql");
    await migration(database, "0004_create_organizations.sql");
    database.exec(`CREATE TABLE deleted_object_cleanup (
      id TEXT PRIMARY KEY, organization_id TEXT, object_key TEXT UNIQUE,
      deleted_at TEXT, cleanup_token TEXT, cleanup_claimed_at TEXT)`);
    for (const file of [
      "0041_create_employee_requirements.sql",
      "0042_add_checkr_screenings.sql",
      "0043_queue_employee_document_cleanup.sql",
      "0044_guard_employee_screenings.sql",
      "0045_track_employee_form_uploads.sql",
      "0046_version_employee_screening_refresh.sql",
      "0047_bind_employee_screening_attempt.sql",
      "0052_track_checkr_refreshes.sql",
    ]) {
      await migration(database, file);
    }
    const insert = database.query(`INSERT INTO employee_requirements
      (id, organization_id, target_email, kind, title, due_date, status,
       created_at, updated_at, checkr_candidate_id, checkr_invitation_id,
       checkr_invitation_status, checkr_report_id, checkr_result)
      VALUES (?, ?, 'a@example.com', 'background_check', 'Check',
              '2026-10-01', ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "reported",
      orgId,
      "complete",
      now(),
      now(),
      "c1",
      "i1",
      "completed",
      "r1",
      "clear",
    );
    insert.run(
      "canceled",
      orgId,
      "pending",
      now(),
      now(),
      "c2",
      "i2",
      "partially_canceled",
      "r2",
      "consider",
    );
    insert.run(
      "invited",
      orgId,
      "in_progress",
      now(),
      now(),
      "c3",
      "i3",
      "pending",
      null,
      null,
    );
    await expect(
      migrationInTransaction(database, "0067_self_host_checkr_screenings.sql"),
    ).rejects.toThrow("Finish or cancel open hosted Checkr invitations first");
    expect(
      database
        .query(
          "SELECT checkr_invitation_id FROM employee_requirements WHERE id = 'invited'",
        )
        .get(),
    ).toEqual({ checkr_invitation_id: "i3" });
    database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_status = 'expired' WHERE id = 'invited'`)
      .run();
    await migrationInTransaction(
      database,
      "0067_self_host_checkr_screenings.sql",
    );
    expect(
      database
        .query(`SELECT id, status, checkr_candidate_id, checkr_report_id,
                       checkr_report_status
                FROM employee_requirements ORDER BY id`)
        .all(),
    ).toEqual([
      {
        checkr_candidate_id: "c2",
        checkr_report_id: "r2",
        checkr_report_status: "partially_canceled",
        id: "canceled",
        status: "pending",
      },
      {
        checkr_candidate_id: null,
        checkr_report_id: null,
        checkr_report_status: null,
        id: "invited",
        status: "pending",
      },
      {
        checkr_candidate_id: "c1",
        checkr_report_id: "r1",
        checkr_report_status: "complete",
        id: "reported",
        status: "complete",
      },
    ]);
  });
});

interface CheckrCall {
  body: FormData | string | null;
  idempotencyKey: string | null;
  method: string;
  url: string;
}

/** Records Checkr API calls, by path, and answers them with respond. */
function mockCheckr(
  respond: (call: CheckrCall) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  const mock = {
    calls: [] as CheckrCall[],
    respond,
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input, init) => {
    const call: CheckrCall = {
      body:
        init?.body instanceof FormData
          ? init.body
          : (init?.body?.toString() ?? null),
      idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      method: init?.method ?? "GET",
      url: String(input).replace("https://api.checkr-staging.com/v1", ""),
    };
    mock.calls.push(call);
    return mock.respond(call);
  }) as typeof fetch;
  return mock;
}

/** Checkr staging accepting a submission and completing its report. */
function checkrResponses(call: CheckrCall) {
  if (call.method === "POST" && call.url === "/candidates") {
    return Response.json({ id: "candidate-1" });
  }
  if (call.url.endsWith("/documents")) {
    return Response.json({ id: "document-1" }, { status: 201 });
  }
  if (call.method === "POST" && call.url === "/reports") {
    return Response.json({ id: "report-1", result: null, status: "pending" });
  }
  if (call.url === "/reports/report-1") {
    return Response.json({
      id: "report-1",
      result: "clear",
      status: "complete",
    });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
}

function configureCheckr(fixture: Awaited<ReturnType<typeof createFixture>>) {
  fixture.bindings.CHECKR_API_KEY = "staging-key";
  fixture.bindings.CHECKR_ENV = "staging";
  fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
}

/** A background check requested in San Jose, CA and awaiting the person. */
async function requestedScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  configureCheckr(fixture);
  const id = await createRequirement(
    fixture,
    "background_check",
    "Background check",
  );
  const requested = await fixture
    .app("owner", "owner")
    .request(
      `/${id}/checkr/request`,
      jsonPost({ city: "San Jose", state: "CA" }),
    );
  expect(requested.status).toBe(200);
  return id;
}

/** A background check whose report Checkr is preparing. */
async function orderedScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  reportId = "report-1",
) {
  configureCheckr(fixture);
  const id = await createRequirement(
    fixture,
    "background_check",
    "Background check",
  );
  fixture.database
    .query(`UPDATE employee_requirements
            SET checkr_candidate_id = ?, checkr_report_id = ?,
                checkr_report_status = 'pending', status = 'in_progress',
                checkr_requested_at = ?, checkr_work_state = 'CA'
            WHERE id = ?`)
    .run(
      reportId === "report-1" ? "candidate-1" : `candidate-${id}`,
      reportId,
      now(),
      id,
    );
  return id;
}

/** Mocked candidate Homer Simpson, whom Checkr staging always clears. */
function homerSubmission() {
  return {
    acknowledgments: {
      disclosure: true,
      stateNotices: ["CA"],
      summaryOfRights: true,
    },
    candidate: {
      dob: "1983-02-10",
      driverLicenseNumber: "M2233344",
      driverLicenseState: "CA",
      firstName: "Homer",
      lastName: "Simpson",
      noMiddleName: true,
      phone: "",
      ssn: "110-11-1100",
      zipcode: "94088",
    },
    copyRequested: true,
    residenceState: "CA",
    signature: {
      authorize: true,
      electronicRecords: true,
      name: "Homer Simpson",
    },
  };
}

/**
 * Submits the form, answering the current request with Acme's current
 * disclosures unless the body names others.
 */
async function submitScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  body: unknown,
  user = "employee",
  role = "member",
) {
  const current = fixture.database
    .query("SELECT checkr_requested_at FROM employee_requirements WHERE id = ?")
    .get(id) as { checkr_requested_at: string | null } | null;
  return fixture.app(user, role).request(`/${id}/checkr/submit`, {
    body: JSON.stringify({
      disclosureFingerprint: await disclosureFingerprint(
        screeningDisclosures("Acme"),
      ),
      requestRevision: current?.checkr_requested_at,
      ...(body as object),
    }),
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Test browser",
    },
    method: "POST",
  });
}

// Runs action just before a Checkr refresh records its result, skipping any
// earlier writes such as a webhook's refresh request.
function beforeCheckrRefreshWrite(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  action: () => void,
) {
  const arm = () => {
    fixture.beforeRun((query) => {
      if (
        query.includes("checkr_refresh_revision = checkr_refresh_revision + 1")
      ) {
        action();
      } else {
        arm();
      }
    });
  };
  arm();
}

function withoutCheckrKey(bindings: Bindings): Bindings {
  const { CHECKR_API_KEY: _apiKey, ...configured } = bindings;
  return configured;
}

async function checkrWebhook(
  bindings: Bindings,
  event: unknown,
  signingKey: string | null = "staging-key",
) {
  const body = JSON.stringify(event);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (signingKey) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    headers.set("X-Checkr-Signature", Buffer.from(digest).toString("hex"));
  }
  const app = new Hono<{ Bindings: Bindings }>();
  app.post("/webhook", handleCheckrWebhook);
  const background: Promise<unknown>[] = [];
  const executionContext = {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as ExecutionContext;
  const response = await app.request(
    "/webhook",
    { body, headers, method: "POST" },
    bindings,
    executionContext,
  );
  await Promise.all(background);
  return response;
}

async function createRequirement(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  kind: string,
  title: string,
) {
  const response = await fixture.app("owner", "owner").request(
    "/",
    jsonPost({
      memberId: "employee-member",
      requirements: [{ kind, title, dueDate: "2026-10-01" }],
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { ids: string[] }).ids[0] ?? "";
}

function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  };
}

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await migration(database, "0003_create_auth.sql");
  for (const id of ["owner", "employee", "invitee", "other"]) {
    database
      .query(`INSERT INTO user
      (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
      VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`)
      .run(id, id, `${id}@example.com`, now(), now());
  }
  await migration(database, "0004_create_organizations.sql");
  database
    .query("UPDATE organization SET name = 'Acme' WHERE id = ?")
    .run(orgId);
  database
    .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('employee-member', ?, 'employee', 'member', ?)`)
    .run(orgId, now());
  database
    .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('other-member', 'org_other', 'invitee', 'member', ?)`)
    .run(now());
  database
    .query(`INSERT INTO invitation
    (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
    VALUES ('invite', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
    .run(orgId, "2026-10-01", now());
  database.exec(`CREATE TABLE deleted_object_cleanup (
    id TEXT PRIMARY KEY, organization_id TEXT, object_key TEXT UNIQUE,
    deleted_at TEXT, cleanup_token TEXT, cleanup_claimed_at TEXT)`);
  await migration(database, "0041_create_employee_requirements.sql");
  await migration(database, "0042_add_checkr_screenings.sql");
  await migration(database, "0043_queue_employee_document_cleanup.sql");
  await migration(database, "0044_guard_employee_screenings.sql");
  await migration(database, "0045_track_employee_form_uploads.sql");
  await migration(database, "0046_version_employee_screening_refresh.sql");
  await migration(database, "0047_bind_employee_screening_attempt.sql");
  await migration(database, "0052_track_checkr_refreshes.sql");
  await migration(database, "0067_self_host_checkr_screenings.sql");
  const files = new Map<string, File>();
  const emails: Array<{
    subject: string;
    text: string;
    to: { email: string; name: string };
  }> = [];
  const storageState = { failPutAfterWrite: false, failDelete: false };
  const hooks: {
    beforeBatch: (() => void) | undefined;
    beforeFirst: ((query: string) => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
    afterRun: (() => void) | undefined;
    beforeDocumentUpdate: (() => void) | undefined;
  } = {
    beforeBatch: undefined,
    beforeFirst: undefined,
    beforeRun: undefined,
    afterRun: undefined,
    beforeDocumentUpdate: undefined,
  };
  const bindings = {
    AUTH_EMAIL_FROM: "no-reply@balebase.test",
    BETTER_AUTH_SECRET: "test-secret",
    CORS_ORIGIN: "https://app.balebase.test",
    DB: toD1(database, hooks),
    EMAIL: {
      send: async (message: (typeof emails)[number]) => {
        emails.push(message);
      },
    },
    STORAGE: {
      put: async (key: string, file: File | Uint8Array) => {
        files.set(
          key,
          file instanceof File
            ? file
            : new File([file], key, { type: "application/pdf" }),
        );
        if (storageState.failPutAfterWrite) {
          throw new Error("Upload interrupted.");
        }
      },
      delete: async (key: string) => {
        if (storageState.failDelete) throw new Error("Storage unavailable.");
        files.delete(key);
      },
      get: async (key: string) => {
        const file = files.get(key);
        return file
          ? {
              body: file.stream(),
              writeHttpMetadata: (headers: Headers) => {
                headers.set("content-type", file.type);
              },
            }
          : null;
      },
    },
  } as unknown as Bindings;
  return {
    app: (
      userId: string,
      role: string,
      via: { apiKey?: boolean; impersonatedBy?: string } = {},
    ) => {
      const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
      app.use("*", async (context, next) => {
        context.set("organizationId", orgId);
        context.set("organizationRole", role);
        context.set("authSession", {
          session: { impersonatedBy: via.impersonatedBy ?? null },
          user: { id: userId },
        } as AuthSession);
        if (via.apiKey) {
          context.set("apiKey", {
            access: "write",
          } as AuthVariables["apiKey"] & object);
        }
        await next();
      });
      app.route("/", employeeForms);
      return {
        request: (path: string, init?: RequestInit) =>
          app.request(path, init, bindings),
      };
    },
    bindings,
    beforeBatch: (callback: () => void) => {
      hooks.beforeBatch = callback;
    },
    beforeFirst: (callback: (query: string) => void) => {
      hooks.beforeFirst = callback;
    },
    beforeRun: (callback: (query: string) => void) => {
      hooks.beforeRun = callback;
    },
    afterRun: (callback: () => void) => {
      hooks.afterRun = callback;
    },
    beforeDocumentUpdate: (callback: () => void) => {
      hooks.beforeDocumentUpdate = callback;
    },
    database,
    emails,
    files,
    storageState,
  };
}

function toD1(
  database: Database,
  hooks: {
    beforeBatch: (() => void) | undefined;
    beforeFirst: ((query: string) => void) | undefined;
    beforeRun: ((query: string) => void) | undefined;
    afterRun: (() => void) | undefined;
    beforeDocumentUpdate: (() => void) | undefined;
  },
) {
  return {
    batch: async (statements: Array<{ execute: () => unknown }>) => {
      const callback = hooks.beforeBatch;
      hooks.beforeBatch = undefined;
      callback?.();
      return statements.map((statement) => statement.execute());
    },
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({ results: database.query(query).all(...values) }),
        bind: (...next: SQLQueryBindings[]) => {
          values = next;
          return statement;
        },
        execute: () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        first: async () => {
          hooks.beforeFirst?.(query);
          return database.query(query).get(...values);
        },
        run: async () => {
          if (
            query.includes("SET document_key = ?") &&
            hooks.beforeDocumentUpdate
          ) {
            const before = hooks.beforeDocumentUpdate;
            hooks.beforeDocumentUpdate = undefined;
            before();
          }
          const callback = hooks.beforeRun;
          hooks.beforeRun = undefined;
          callback?.(query);
          const result = database.query(query).run(...values);
          if (query.includes("SET document_key = ?") && hooks.afterRun) {
            const after = hooks.afterRun;
            hooks.afterRun = undefined;
            after();
          }
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

/**
 * Applies a migration atomically and statement by statement, as D1 does;
 * bun:sqlite's exec would skip a statement that fails partway through.
 */
async function migrationInTransaction(database: Database, filename: string) {
  const sql = await Bun.file(
    new URL(`../migrations/${filename}`, import.meta.url),
  ).text();
  const statements: string[] = [];
  let statement = "";
  for (const line of sql.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    statement += `${line}\n`;
    const ended = /^\s*CREATE TRIGGER/i.test(statement)
      ? /^END;$/i.test(line.trim())
      : line.trim().endsWith(";");
    if (ended) {
      statements.push(statement);
      statement = "";
    }
  }
  database.run("BEGIN");
  try {
    // A trailing semicolon would make Bun treat each as a script again.
    for (const next of statements) database.run(next.trim().replace(/;$/, ""));
    database.run("COMMIT");
  } catch (cause) {
    database.run("ROLLBACK");
    throw cause;
  }
}

async function migration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}

function now() {
  return "2026-09-24T12:00:00.000Z";
}
