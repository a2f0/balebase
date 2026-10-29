import { describe, expect, it } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { purgeDeletedObjects } from "../library/deletedObjectCleanup";
import {
  type Contract,
  createFixture,
  draft,
  roleMapping,
  type SentEmail,
  samplePdf,
  signers,
  templateVersion,
  timestamp,
  uploadTemplate,
} from "../testing/contractFixture";
import { streamedUpload } from "../testing/http";
import {
  resumeStalledContracts,
  sendContractReminders,
} from "./contractReminders";

const png = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII="}`;

describe("contracts", () => {
  it("uploads a PDF and validates drafts before sending", async () => {
    const fixture = createFixture();
    expect(
      (await fixture.upload(new TextEncoder().encode("not a pdf"), "notes.txt"))
        .status,
    ).toBe(400);
    const created = await fixture.upload(
      await samplePdf(),
      "Services agreement.pdf",
    );
    expect(created.status).toBe(201);
    expect(created.body.contract).toMatchObject({
      document: { pageCount: 2 },
      events: [{ type: "created" }],
      status: "draft",
    });
    const id = created.body.contract.id;

    for (const [change, message] of [
      [{ title: "" }, "title"],
      [
        {
          recipients: [signers[0], { ...signers[1], email: "SAM@example.com" }],
        },
        "more than once",
      ],
      [{ fields: [{ ...draft().fields[0], page: 3 }] }, "page"],
      [{ fields: [{ ...draft().fields[0], x: 0.8 }] }, "edge"],
      [
        { fields: [{ ...draft().fields[0], recipientKey: "nobody" }] },
        "signer",
      ],
      [{ reminderIntervalDays: 45 }, "Reminders"],
      [{ dueDate: "2026-02-30" }, "due date"],
    ] as const) {
      const saved = await fixture.json<{ error: string }>(
        "PUT",
        `/api/contracts/${id}/draft`,
        draft(change),
      );
      expect(saved.status).toBe(400);
      expect(saved.body.error).toContain(message);
    }

    const saved = await fixture.json<{ contract: Contract }>(
      "PUT",
      `/api/contracts/${id}/draft`,
      draft({
        fields: draft().fields.filter(
          ({ recipientKey }) => recipientKey === "sam",
        ),
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.contract.recipients.map(({ name }) => name)).toEqual([
      "Sam Signer",
      "Cai Cosigner",
    ]);
    const unsent = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(unsent.status).toBe(400);
    expect(unsent.body.error).toBe("Place a signature field for Cai Cosigner.");

    // Drafts save half-filled signers; sending needs a name and an email.
    for (const [signer, message] of [
      [{ ...signers[1], name: "" }, "Every signer needs a name."],
      [
        { ...signers[1], email: "cai@" },
        "“Cai Cosigner” needs a valid email address.",
      ],
    ] as const) {
      const halfFilled = await fixture.json(
        "PUT",
        `/api/contracts/${id}/draft`,
        draft({ recipients: [signers[0], signer] }),
      );
      expect(halfFilled.status).toBe(200);
      const blocked = await fixture.json<{ error: string }>(
        "POST",
        `/api/contracts/${id}/send`,
      );
      expect(blocked.status).toBe(400);
      expect(blocked.body.error).toBe(message);
    }
    expect(fixture.emails).toEqual([]);
  });

  it("collects parallel signatures and completes with a stamped PDF", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft());
    const sent = await fixture.json<{ contract: Contract }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(sent.body.contract.status).toBe("sent");
    expect(sent.body.contract.recipients.map(({ status }) => status)).toEqual([
      "sent",
      "sent",
    ]);
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "cai@example.com",
    ]);
    expect(fixture.emails[0]).toMatchObject({
      replyTo: "owner@example.com",
      subject: "Olivia Owner sent you “Services agreement” to sign",
    });
    expect(fixture.emails[0]?.text).toContain("Please review before Friday.");
    const samToken = tokenFrom(fixture.emails[0]);
    const caiToken = tokenFrom(fixture.emails[1]);

    const view = await fixture.json<{
      canSign: boolean;
      contract: { organizationName: string; senderName: string };
      fields: Array<{ id: string; type: string }>;
    }>("GET", `/api/signing/${samToken}`);
    expect(view.body).toMatchObject({
      canSign: true,
      contract: { organizationName: "Acme, Inc.", senderName: "Olivia Owner" },
    });
    expect(view.body.fields.map(({ type }) => type)).toEqual([
      "signature",
      "date_signed",
      "text",
    ]);
    const textField = view.body.fields.find(({ type }) => type === "text");
    expect(
      (await fixture.request(`/api/signing/${samToken}/document`)).status,
    ).toBe(200);

    for (const [body, message] of [
      [{ signature: png }, "Agree"],
      [{ consent: true }, "Adopt a signature"],
      [
        { consent: true, signature: "data:image/png;base64,AAAA" },
        "Adopt a signature",
      ],
      [{ consent: true, signature: png, values: {} }, "required"],
    ] as const) {
      const rejected = await fixture.json<{ error: string }>(
        "POST",
        `/api/signing/${samToken}/sign`,
        body,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain(message);
    }
    const first = await fixture.json<{ completed: boolean; status: string }>(
      "POST",
      `/api/signing/${samToken}/sign`,
      {
        consent: true,
        signature: png,
        values: { [textField?.id ?? ""]: "Director" },
      },
    );
    expect(first.body).toEqual({ completed: false, status: "signed" });
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.json("POST", `/api/signing/${caiToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(400);

    fixture.emails.length = 0;
    const last = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${caiToken}/sign`,
      {
        consent: true,
        initials: png,
        signature: png,
      },
    );
    expect(last.body.completed).toBe(true);
    const detail = await fixture.json<{ contract: Contract }>(
      "GET",
      `/api/contracts/${id}`,
    );
    expect(detail.body.contract.status).toBe("completed");
    expect(detail.body.contract.finalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.body.contract.events.map(({ type }) => type)).toEqual([
      "created",
      "sent",
      "notified",
      "notified",
      "viewed",
      "signed",
      "signed",
      "completed",
    ]);
    expect(
      fixture.emails.map(({ subject, to }) => [to.email, subject]),
    ).toEqual([
      ["sam@example.com", "Completed: “Services agreement”"],
      ["cai@example.com", "Completed: “Services agreement”"],
      ["owner@example.com", "Completed: “Services agreement”"],
    ]);
    expect(fixture.emails[0]?.attachments?.[0]).toMatchObject({
      filename: "Services agreement (signed).pdf",
      type: "application/pdf",
    });

    const final = await fixture.request(`/api/signing/${samToken}/final`);
    expect(final.status).toBe(200);
    const signed = await PDFDocument.load(
      new Uint8Array(await final.arrayBuffer()),
    );
    expect(signed.getPageCount()).toBeGreaterThanOrEqual(3);
    expect((await fixture.request(`/api/contracts/${id}/final`)).status).toBe(
      200,
    );
    expect(
      (
        await fixture.json<{ canSign: boolean }>(
          "GET",
          `/api/signing/${caiToken}`,
        )
      ).body.canSign,
    ).toBe(false);
  });

  it("routes sequential signers one at a time", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft({ signingOrder: "sequential" }));
    await fixture.json("POST", `/api/contracts/${id}/send`);
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
    ]);
    const pending = await fixture.json<{ contract: Contract }>(
      "GET",
      `/api/contracts/${id}`,
    );
    expect(
      pending.body.contract.recipients.map(({ status }) => status),
    ).toEqual(["sent", "pending"]);

    const view = await fixture.json<{
      fields: Array<{ id: string; type: string }>;
    }>("GET", `/api/signing/${tokenFrom(fixture.emails[0])}`);
    const textField = view.body.fields.find(({ type }) => type === "text");
    await fixture.json(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      {
        consent: true,
        signature: png,
        values: { [textField?.id ?? ""]: "Director" },
      },
    );
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "cai@example.com",
    ]);
  });

  it("records declines, voids, and deletions", async () => {
    const fixture = createFixture();
    const declinedId = await fixture.prepare(draft());
    await fixture.json("POST", `/api/contracts/${declinedId}/send`);
    const samToken = tokenFrom(fixture.emails[0]);
    fixture.emails.length = 0;
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/decline`, {
          reason: "Wrong rate",
        })
      ).status,
    ).toBe(200);
    expect(fixture.emails).toMatchObject([
      {
        subject: "Declined: “Services agreement”",
        to: { email: "owner@example.com" },
      },
    ]);
    expect(fixture.emails[0]?.text).toContain("Reason: Wrong rate");
    expect(
      (
        await fixture.json<{ contract: Contract }>(
          "GET",
          `/api/contracts/${declinedId}`,
        )
      ).body.contract.status,
    ).toBe("declined");
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(409);

    const voidedId = await fixture.prepare(draft());
    fixture.emails.length = 0;
    await fixture.json("POST", `/api/contracts/${voidedId}/send`);
    const voidedToken = tokenFrom(fixture.emails[0]);
    expect(
      (await fixture.json("DELETE", `/api/contracts/${voidedId}`)).status,
    ).toBe(409);
    fixture.emails.length = 0;
    expect(
      (
        await fixture.json("POST", `/api/contracts/${voidedId}/void`, {
          reason: 5,
        })
      ).body,
    ).toEqual({ error: "A void reason must be text." });
    const voided = await fixture.json<{ contract: Contract }>(
      "POST",
      `/api/contracts/${voidedId}/void`,
      {
        reason: "Terms changed",
      },
    );
    expect(voided.body.contract.status).toBe("voided");
    expect(fixture.emails.map(({ subject }) => subject)).toEqual([
      "Voided: “Services agreement”",
      "Voided: “Services agreement”",
    ]);
    expect(
      (
        await fixture.json<{ canSign: boolean; contract: { status: string } }>(
          "GET",
          `/api/signing/${voidedToken}`,
        )
      ).body,
    ).toMatchObject({ canSign: false, contract: { status: "voided" } });
    expect(
      (await fixture.request(`/api/signing/${voidedToken}/document`)).status,
    ).toBe(410);

    expect(
      (await fixture.json("DELETE", `/api/contracts/${voidedId}`)).status,
    ).toBe(204);
    expect(
      (await fixture.json("GET", `/api/contracts/${voidedId}`)).status,
    ).toBe(404);
    expect(
      fixture.database
        .query("SELECT id FROM deleted_object_cleanup WHERE id = ?")
        .get(`contract-document:${voidedId}`),
    ).toBeTruthy();
    expect(
      (await fixture.json("GET", `/api/signing/${voidedToken}`)).status,
    ).toBe(404);
  });

  it("reminds signers on their contract's schedule and on request", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft({ reminderIntervalDays: 2 }));
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const samToken = tokenFrom(fixture.emails[0]);
    const sentAt = Date.now();
    fixture.emails.length = 0;

    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(sentAt + 86_400_000),
      ),
    ).toBe(0);
    const later = new Date(sentAt + 2 * 86_400_000 + 3_600_000);
    expect(await sendContractReminders(fixture.bindings, later)).toBe(2);
    expect(fixture.emails.map(({ subject }) => subject)).toEqual([
      "Reminder: please sign “Services agreement”",
      "Reminder: please sign “Services agreement”",
    ]);
    expect(tokenFrom(fixture.emails[0])).toBe(samToken);
    expect(await sendContractReminders(fixture.bindings, later)).toBe(0);

    fixture.emails.length = 0;
    const throttled = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/remind`,
    );
    expect(throttled.status).toBe(429);
    fixture.database
      .query("UPDATE contract_recipients SET last_reminded_at = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    // A double click reminds each signer once.
    const [manual, doubled] = await Promise.all([
      fixture.json<{ reminded: number }>("POST", `/api/contracts/${id}/remind`),
      fixture.json<{ reminded: number }>("POST", `/api/contracts/${id}/remind`),
    ]);
    expect(manual.body.reminded + (doubled.body.reminded ?? 0)).toBe(2);
    expect(fixture.emails).toHaveLength(2);
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/remind`)).status,
    ).toBe(429);
    await fixture.json("POST", `/api/contracts/${id}/void`, {});
    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(sentAt + 30 * 86_400_000),
      ),
    ).toBe(0);
  });

  it("finishes a contract whose completion failed after the last signature", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    fixture.emails.length = 0;
    fixture.storage.failWrites = true;
    const signed = await fixture.json<{ completed: boolean; status: string }>(
      "POST",
      `/api/signing/${token}/sign`,
      { consent: true, signature: png },
    );
    expect(signed.body).toEqual({ completed: false, status: "signed" });
    const hour = (count: number) => new Date(Date.now() + count * 3_600_000);
    expect(await resumeStalledContracts(fixture.bindings, hour(0))).toBe(0);
    expect(await statusOf(fixture, id)).toBe("sent");
    // An attempt is leased, so an overlapping run leaves it alone.
    expect(await resumeStalledContracts(fixture.bindings, hour(0))).toBe(0);

    fixture.storage.failWrites = false;
    expect(await resumeStalledContracts(fixture.bindings, hour(1))).toBe(1);
    expect(await statusOf(fixture, id)).toBe("completed");
    expect(fixture.emails.map(({ to }) => to.email)).toEqual([
      "sam@example.com",
      "owner@example.com",
    ]);
    expect(await resumeStalledContracts(fixture.bindings, hour(2))).toBe(0);
  });

  it("gives up on a contract that keeps failing to complete", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    fixture.storage.failWrites = true;
    await fixture.json(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      { consent: true, signature: png },
    );
    for (let hour = 1; hour <= 7; hour++) {
      await resumeStalledContracts(
        fixture.bindings,
        new Date(Date.now() + hour * 3_600_000),
      );
    }
    expect(
      fixture.database
        .query("SELECT resume_attempts AS attempts FROM contracts WHERE id = ?")
        .get(id),
    ).toEqual({ attempts: 5 });
    expect(await statusOf(fixture, id)).toBe("sent");
  });

  it("refuses a send when the draft changes while it is validated", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft());
    // A save from another tab lands between validation and the send.
    fixture.hooks.before("SET status = 'sent'", () => {
      fixture.database
        .query("UPDATE contracts SET revision = revision + 1 WHERE id = ?")
        .run(id);
    });
    const raced = await fixture.json<{ error: string }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(raced.status).toBe(409);
    expect(raced.body.error).toContain("changed while it was being sent");
    expect(await statusOf(fixture, id)).toBe("draft");
    expect(fixture.emails).toEqual([]);
  });

  it("queues every contract file for cleanup until its row claims it", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const signed = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      { consent: true, signature: png },
    );
    expect(signed.body.completed).toBe(true);
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    await fixture.json("POST", `${path}/versions`, templateVersion(template));
    const copied = await fixture.json(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(copied.status).toBe(201);
    // The upload, the signed copy, the template, and the template's copy.
    expect(fixture.storage.queuedAtPut).toEqual([true, true, true, true]);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("leaves an upload whose response was lost to the cleanup", async () => {
    const fixture = createFixture();
    fixture.storage.loseNextResponse = true;
    const lost = await fixture.upload(await samplePdf(), "Lost.pdf");
    expect(lost.status).toBe(500);
    const [lostKey] = [...fixture.stored.keys()];
    expect(
      fixture.database
        .query("SELECT object_key FROM deleted_object_cleanup")
        .all(),
    ).toEqual([{ object_key: lostKey }]);
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await purgeDeletedObjects(fixture.bindings, {
      abandonedClaimedBefore: later,
      deletedBefore: later,
    });
    expect(fixture.stored.size).toBe(0);
  });

  it("refuses an oversized contract while it streams", async () => {
    const fixture = await createFixture();
    const fileBytes = 32 * 1024 * 1024;
    const upload = streamedUpload(fileBytes);
    const response = await fixture.request("/api/contracts", {
      body: upload.body,
      headers: upload.headers,
      method: "POST",
    });
    expect(response.status).toBe(413);
    expect(upload.progress.cancelled).toBe(true);
    expect(upload.progress.sentBytes).toBeLessThan(fileBytes);
    expect(fixture.stored.size).toBe(0);
  });

  it("rejects adopted images that could not be stamped", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    const bytes = Uint8Array.from(atob(png.split(",")[1] ?? ""), (character) =>
      character.charCodeAt(0),
    );
    new DataView(bytes.buffer).setUint32(16, 20_000);
    const oversized = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    const rejected = await fixture.json<{ error: string }>(
      "POST",
      `/api/signing/${token}/sign`,
      { consent: true, signature: oversized },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe(
      "The adopted signature could not be read.",
    );
    expect(await statusOf(fixture, id)).toBe("sent");
  });

  it("retires signing links when the auth secret rotates", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(solo());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const original = tokenFrom(fixture.emails[0]);
    fixture.bindings.BETTER_AUTH_SECRET =
      "rotated-secret-rotated-secret-rotated";
    expect((await fixture.json("GET", `/api/signing/${original}`)).status).toBe(
      404,
    );

    fixture.emails.length = 0;
    fixture.database
      .query("UPDATE contract_recipients SET notified_at = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    const reminded = await fixture.json<{ reminded: number }>(
      "POST",
      `/api/contracts/${id}/remind`,
    );
    expect(reminded.body.reminded).toBe(1);
    const reissued = tokenFrom(fixture.emails[0]);
    expect(reissued).not.toBe(original);
    expect((await fixture.json("GET", `/api/signing/${reissued}`)).status).toBe(
      200,
    );
    expect((await fixture.json("GET", `/api/signing/${original}`)).status).toBe(
      404,
    );
  });

  it("stops contract activity when its organization is deleted", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    fixture.database
      .query("UPDATE organization SET deletedAt = ? WHERE id = 'org-1'")
      .run(timestamp);
    expect((await fixture.json("GET", `/api/signing/${token}`)).status).toBe(
      404,
    );
    expect(
      await sendContractReminders(
        fixture.bindings,
        new Date(Date.now() + 30 * 86_400_000),
      ),
    ).toBe(0);

    fixture.database.query("DELETE FROM organization WHERE id = 'org-1'").run();
    expect(
      fixture.database
        .query("SELECT object_key FROM deleted_object_cleanup")
        .all(),
    ).toEqual([
      {
        object_key: `organizations/org-1/contracts/${id}/original.pdf`,
      },
    ]);
  });

  it("keeps contracts and signing links within their organization", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(draft());
    const outsider = fixture.as("other-user", "org-2");
    for (const [method, path] of [
      ["GET", `/api/contracts/${id}`],
      ["GET", `/api/contracts/${id}/document`],
      ["PUT", `/api/contracts/${id}/draft`],
      ["POST", `/api/contracts/${id}/send`],
      ["DELETE", `/api/contracts/${id}`],
    ] as const) {
      expect((await outsider.json(method, path, draft())).status).toBe(404);
    }
    expect(
      (await outsider.json<{ contracts: unknown[] }>("GET", "/api/contracts"))
        .body.contracts,
    ).toEqual([]);
    expect(
      (await fixture.request(`/api/signing/${"A".repeat(43)}`)).status,
    ).toBe(404);
    expect((await fixture.request("/api/signing/short")).status).toBe(404);
  });
});

/** One signer with one signature field. */
function solo() {
  return draft({ fields: [draft().fields[0]], recipients: [signers[0]] });
}

async function statusOf(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
) {
  const detail = await fixture.json<{ contract: Contract }>(
    "GET",
    `/api/contracts/${id}`,
  );
  return detail.body.contract.status;
}

function tokenFrom(email: SentEmail | undefined) {
  const token = /\/sign\/([A-Za-z0-9_-]{43})/.exec(email?.text ?? "")?.[1];
  if (!token) throw new Error("No signing link in email.");
  return token;
}
