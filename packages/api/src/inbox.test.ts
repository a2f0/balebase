import { describe, expect, it } from "bun:test";
import { inbox } from "./inbox";
import { memoryStorage, testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { applyMigrations, createTestDatabase } from "./testing/database";
import { seedUser } from "./testing/seed";
import { testApp } from "./testing/session";

const organizationId = "org_owner-user";
const otherOrganizationId = "org_other-user";
const emailId = "email-1";
const attachmentId = "attachment-1";
const rawObjectKey = `inbound-emails/${emailId}/message.eml`;
const attachmentObjectKey = `inbound-emails/${emailId}/attachments/${attachmentId}`;
const otherEmailId = "email-2";
const otherAttachmentId = "attachment-2";
const otherRawObjectKey = `organizations/${otherOrganizationId}/inbound-emails/${otherEmailId}/message.eml`;
const otherAttachmentObjectKey = `organizations/${otherOrganizationId}/inbound-emails/${otherEmailId}/attachments/${otherAttachmentId}`;
const rawEmail = [
  "From: Sender <sender@example.com>",
  "To: upload@inbox.balebase.com",
  "Subject: Test attachment",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="test-boundary"',
  "",
  "--test-boundary",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Hello from the message body.",
  "--test-boundary",
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8gYXR0YWNobWVudA==",
  "--test-boundary--",
  "",
].join("\r\n");

describe("inbox", () => {
  it("refuses to render stored mail with oversized headers", async () => {
    const fixture = await createFixture(
      `X-Large: ${"x".repeat(128 * 1024)}\r\n\r\nbody`,
    );
    const response = await fixture.request(`/${emailId}`);
    expect(response.status).toBe(500);
  });

  it("refuses to render stored mail with excessive MIME nesting", async () => {
    let raw = "Content-Type: text/plain\r\n\r\nbody";
    for (let depth = 0; depth < 32; depth++) {
      raw = `Content-Type: multipart/mixed; boundary="level-${depth}"\r\n\r\n--level-${depth}\r\n${raw}\r\n--level-${depth}--\r\n`;
    }
    const fixture = await createFixture(raw);
    const response = await fixture.request(`/${emailId}`);
    expect(response.status).toBe(500);
  });

  it("does not render an embedded message inline", async () => {
    const fixture = await createFixture(
      "Content-Type: message/rfc822\r\n\r\nContent-Type: text/html\r\n\r\n<p>nested body</p>",
    );
    const response = await fixture.request(`/${emailId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: { html: null, text: null },
    });
  });

  it("archives messages with attachments and restores them to Inbox", async () => {
    const fixture = await createFixture();
    expect(
      (await fixture.request(`/${emailId}/archive`, { method: "POST" })).status,
    ).toBe(200);
    expect(await (await fixture.request("/")).json()).toMatchObject({
      emails: [],
    });
    expect(
      await (await fixture.request("/?folder=trash")).json(),
    ).toMatchObject({ emails: [] });
    expect(
      await (await fixture.request("/?folder=archived")).json(),
    ).toMatchObject({
      emails: [
        {
          id: emailId,
          status: "archived",
          deletedAt: null,
          attachmentCount: 1,
        },
      ],
    });
    expect((await fixture.request(`/${emailId}`)).status).toBe(404);
    expect((await fixture.request(`/${emailId}?folder=trash`)).status).toBe(
      404,
    );
    expect(
      (await fixture.request(`/${emailId}/attachments/${attachmentId}`)).status,
    ).toBe(404);
    expect((await fixture.request(`/${emailId}?folder=archived`)).status).toBe(
      200,
    );
    const attachment = await fixture.request(
      `/${emailId}/attachments/${attachmentId}?folder=archived`,
    );
    expect(await attachment.text()).toBe("hello attachment");
    expect(
      (await fixture.request(`/${otherEmailId}/archive`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await fixture.request(`/${otherEmailId}/restore`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await fixture.request(`/${otherEmailId}?folder=archived`)).status,
    ).toBe(404);
    expect(
      (await fixture.request(`/${emailId}/restore`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      await (await fixture.request("/?folder=archived")).json(),
    ).toMatchObject({ emails: [] });
    expect(await (await fixture.request(`/${emailId}`)).json()).toMatchObject({
      email: { status: "inbox" },
    });
  });

  it("trashes unlinked archived email and only restores it to Inbox", async () => {
    const fixture = await createFixture();
    await fixture.request(`/${emailId}/archive`, { method: "POST" });
    expect(
      (await fixture.request(`/${emailId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      await (await fixture.request("/?folder=archived")).json(),
    ).toMatchObject({ emails: [] });
    expect(
      await (await fixture.request(`/${emailId}?folder=trash`)).json(),
    ).toMatchObject({ email: { status: "trash" } });
    expect(
      (await fixture.request(`/${emailId}/archive`, { method: "POST" })).status,
    ).toBe(404);
    await fixture.request(`/${emailId}/restore`, { method: "POST" });
    expect(await (await fixture.request(`/${emailId}`)).json()).toMatchObject({
      email: { status: "inbox" },
    });
  });

  it("lists messages, renders a body, and downloads attachments", async () => {
    const fixture = await createFixture();

    const list = await fixture.request("/");
    expect(list.status).toBe(200);
    const listBody: unknown = await list.json();
    expect(listBody).toEqual({
      address: `upload+${organizationId}@inbox.balebase.com`,
      emails: [
        {
          attachmentCount: 1,
          deletedAt: null,
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
          from: "sender@example.com",
          id: emailId,
          linkCount: 0,
          rawSize: new TextEncoder().encode(rawEmail).byteLength,
          receivedAt: "2026-08-18T12:00:00.000Z",
          subject: "Test attachment",
          status: "inbox",
          to: "upload@inbox.balebase.com",
        },
      ],
    });

    const detail = await fixture.request(`/${emailId}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      email: { attachments: object[]; text: string };
    };
    expect(detailBody.email.attachments).toEqual([
      {
        contentType: "text/plain",
        filename: "notes.txt",
        id: attachmentId,
        size: 16,
      },
    ]);
    expect(detailBody.email.text.trim()).toBe("Hello from the message body.");

    const attachment = await fixture.request(
      `/${emailId}/attachments/${attachmentId}`,
    );
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-disposition")).toContain(
      "notes.txt",
    );
    expect(await attachment.text()).toBe("hello attachment");

    expect((await fixture.request(`/${otherEmailId}`)).status).toBe(404);
    expect(
      (
        await fixture.request(
          `/${otherEmailId}/attachments/${otherAttachmentId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      fixture.database
        .query("SELECT organization_id FROM inbound_emails WHERE id = ?")
        .get(emailId),
    ).toEqual({ organization_id: organizationId });
  });

  it("moves messages to trash, records the actor, and restores them", async () => {
    const fixture = await createFixture();

    const deleted = await fixture.request(`/${emailId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      deletedAt: string;
      deletedByUserId: string;
      emailId: string;
    };
    expect(deletedBody).toMatchObject({
      deletedByUserId: "owner-user",
      emailId,
    });
    expect(new Date(deletedBody.deletedAt).toString()).not.toBe("Invalid Date");

    const activeList = await fixture.request("/");
    expect((await activeList.json()) as { emails: unknown[] }).toMatchObject({
      emails: [],
    });
    expect((await fixture.request(`/${emailId}`)).status).toBe(404);
    expect(
      (await fixture.request(`/${emailId}/attachments/${attachmentId}`)).status,
    ).toBe(404);

    const trashList = await fixture.request("/?folder=trash");
    expect(trashList.status).toBe(200);
    const trashBody = (await trashList.json()) as {
      emails: Array<{
        deletedAt: string;
        deletedByEmail: string;
        deletedByName: string;
        deletedByUserId: string;
        id: string;
      }>;
    };
    expect(trashBody.emails).toEqual([
      expect.objectContaining({
        deletedAt: deletedBody.deletedAt,
        deletedByEmail: "owner-user@example.com",
        deletedByName: "owner-user",
        deletedByUserId: "owner-user",
        id: emailId,
      }),
    ]);
    expect((await fixture.request(`/${emailId}?folder=trash`)).status).toBe(
      200,
    );
    expect(
      (
        await fixture.request(
          `/${emailId}/attachments/${attachmentId}?folder=trash`,
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await fixture.request(`/${otherEmailId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect((await fixture.request("/?folder=archive")).status).toBe(400);

    const restored = await fixture.request(`/${emailId}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    const restoredBody: unknown = await restored.json();
    expect(restoredBody).toEqual({ emailId });
    expect((await fixture.request(`/${emailId}`)).status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT deleted_at, deleted_by_user_id
           FROM inbound_emails WHERE id = ?`,
        )
        .get(emailId),
    ).toEqual({ deleted_at: null, deleted_by_user_id: null });
    expect(
      (await fixture.request(`/${emailId}/restore`, { method: "POST" })).status,
    ).toBe(404);
  });
});

async function createFixture(fixtureRawEmail = rawEmail) {
  // Mail received before organizations existed belongs to Tearleads, LLC.
  const database = createTestDatabase({ before: "0004" });
  seedUser(database, { id: "owner-user" });
  seedUser(database, { id: "other-user" });
  applyMigrations(database, { before: "0012", from: "0004" });
  database
    .query("UPDATE organization SET name = 'Tearleads, LLC' WHERE id = ?")
    .run(organizationId);
  database
    .query(
      `INSERT INTO inbound_emails
       (id, message_id, envelope_from, envelope_to, subject, raw_object_key,
        raw_size, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      emailId,
      "<test@example.com>",
      "sender@example.com",
      "upload@inbox.balebase.com",
      "Test attachment",
      rawObjectKey,
      new TextEncoder().encode(fixtureRawEmail).byteLength,
      "2026-08-18T12:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO inbound_email_attachments
       (id, email_id, object_key, filename, content_type, size, disposition,
        content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attachmentId,
      emailId,
      attachmentObjectKey,
      "notes.txt",
      "text/plain",
      16,
      "attachment",
      null,
      "2026-08-18T12:00:00.000Z",
    );
  applyMigrations(database, { from: "0012" });
  database
    .query(
      `INSERT INTO inbound_emails
       (id, organization_id, message_id, envelope_from, envelope_to, subject,
        raw_object_key, raw_size, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      otherEmailId,
      otherOrganizationId,
      "<other@example.com>",
      "other@example.com",
      `upload+${otherOrganizationId}@inbox.balebase.com`,
      "Other organization",
      otherRawObjectKey,
      new TextEncoder().encode(fixtureRawEmail).byteLength,
      "2026-08-19T12:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO inbound_email_attachments
       (id, email_id, object_key, filename, content_type, size, disposition,
        content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      otherAttachmentId,
      otherEmailId,
      otherAttachmentObjectKey,
      "other.txt",
      "text/plain",
      16,
      "attachment",
      null,
      "2026-08-19T12:00:00.000Z",
    );

  const objects = new Map([
    [rawObjectKey, new TextEncoder().encode(fixtureRawEmail)],
    [attachmentObjectKey, new TextEncoder().encode("hello attachment")],
    [otherRawObjectKey, new TextEncoder().encode(fixtureRawEmail)],
    [otherAttachmentObjectKey, new TextEncoder().encode("other attachment")],
  ]);
  const bindings = testBindings({
    DB: toD1(database),
    STORAGE: memoryStorage(objects).bucket,
  });
  const app = testApp(
    { "/": inbox },
    { organizationId, organizationRole: "member", userId: "owner-user" },
  );
  return {
    database,
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}
