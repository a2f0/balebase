import { describe, expect, it } from "bun:test";
import { objects } from "./objects";
import { memoryStorage, testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { applyMigrations, createTestDatabase } from "./testing/database";
import { requester, streamedUpload } from "./testing/http";
import { seedMember, seedOrganization, seedUser } from "./testing/seed";
import { testApp } from "./testing/session";

interface ObjectResponse {
  object: {
    filename: string;
    id: string;
    objectKey: string;
  };
}

interface ObjectListResponse {
  objects: Array<{
    contentType: string;
    createdAt: string;
    filename: string;
    folderId: string | null;
    id: string;
    objectKey: string;
    size: number;
  }>;
}

describe("organization uploads", () => {
  it("backfills existing uploads and isolates object access", async () => {
    const fixture = createFixture();
    expect(
      fixture.database
        .query("SELECT organization_id, kind FROM objects WHERE id = ?")
        .get("legacy-object"),
    ).toEqual({ kind: "library", organization_id: "org_user-1" });

    const firstList = await fixture.first<ObjectListResponse>("GET", "/");
    expect(firstList.status).toBe(200);
    expect(firstList.body).toEqual({
      objects: [
        {
          filename: "legacy.txt",
          folderId: null,
          id: "legacy-object",
          objectKey: "uploads/legacy-object/legacy.txt",
          contentType: "text/plain",
          size: 6,
          createdAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });

    const hiddenAuditImage = await fixture.first("GET", "/audit-image-object");
    expect(hiddenAuditImage.status).toBe(404);
    const auditImageDelete = await fixture.first(
      "DELETE",
      "/audit-image-object",
    );
    expect(auditImageDelete.status).toBe(404);
    expect(
      fixture.database
        .query("SELECT kind FROM objects WHERE id = ?")
        .get("audit-image-object"),
    ).toEqual({ kind: "audit_issue_image" });
    expect(fixture.stored.has("audit-images/evidence.png")).toBe(true);

    const otherObject = await fixture.first("GET", "/other-object");
    expect(otherObject.status).toBe(404);

    const form = new FormData();
    form.set("file", new File(["new upload"], "report.txt"));
    const uploaded = await fixture.first<ObjectResponse>("POST", "/", form);
    expect(uploaded.status).toBe(201);
    const uploadBody = uploaded.body;
    expect(uploadBody.object.objectKey).toStartWith(
      "organizations/org_user-1/uploads/",
    );
    expect(
      fixture.database
        .query("SELECT organization_id, kind FROM objects WHERE id = ?")
        .get(uploadBody.object.id),
    ).toEqual({ kind: "library", organization_id: "org_user-1" });

    const unicodeForm = new FormData();
    unicodeForm.set(
      "file",
      new File(["unicode upload"], `${"😀".repeat(255)}.txt`),
    );
    const unicodeUpload = await fixture.first<ObjectResponse>(
      "POST",
      "/",
      unicodeForm,
    );
    expect(unicodeUpload.status).toBe(201);
    const unicodeBody = unicodeUpload.body;
    expect(
      new TextEncoder().encode(unicodeBody.object.filename).byteLength,
    ).toBe(252);
    expect(
      new TextEncoder().encode(unicodeBody.object.objectKey).byteLength,
    ).toBeLessThan(1_024);

    const hiddenFromOtherOrganization = await fixture.second(
      "GET",
      `/${uploadBody.object.id}`,
    );
    expect(hiddenFromOtherOrganization.status).toBe(404);

    const deleted = await fixture.first("DELETE", `/${uploadBody.object.id}`);
    expect(deleted.status).toBe(204);
    expect(fixture.stored.has(uploadBody.object.objectKey)).toBe(false);
    expect(
      fixture.database
        .query("SELECT id FROM deleted_object_cleanup WHERE id = ?")
        .get(uploadBody.object.id),
    ).toBeNull();
  });
});

describe("upload limits", () => {
  it("refuses an oversized upload while it streams", async () => {
    const fixture = createFixture();
    const fileBytes = 64 * 1024 * 1024;
    const upload = streamedUpload(fileBytes);
    const response = await fixture.first(
      "POST",
      "/",
      upload.body,
      upload.headers,
    );
    expect(response.status).toBe(413);
    expect(upload.progress.cancelled).toBe(true);
    expect(upload.progress.sentBytes).toBeLessThan(fileBytes);
    expect(fixture.stored.size).toBe(2);
  });
});

function createFixture() {
  // Uploads from before organizations existed belong to their owner's.
  const database = createTestDatabase({ before: "0004" });
  seedUser(database, {
    email: "person@example.com",
    emailVerified: false,
    id: "user-1",
    name: "Example Person",
  });
  applyMigrations(database, { before: "0006", from: "0004" });
  database
    .query(
      `INSERT INTO objects
       (id, object_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-object",
      "uploads/legacy-object/legacy.txt",
      "legacy.txt",
      "text/plain",
      6,
      "2026-08-18T12:00:00.000Z",
    );
  applyMigrations(database, { from: "0006" });
  database
    .query(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'audit_issue_image')`,
    )
    .run(
      "audit-image-object",
      "org_user-1",
      "audit-images/evidence.png",
      "evidence.png",
      "image/png",
      8,
      "2026-08-19T12:00:00.000Z",
    );
  addSecondOrganization(database);
  const { bucket, stored } = memoryStorage(
    new Map([
      ["uploads/legacy-object/legacy.txt", new TextEncoder().encode("legacy")],
      ["audit-images/evidence.png", new Uint8Array(8)],
    ]),
  );
  const bindings = testBindings({ DB: toD1(database), STORAGE: bucket });
  const appFor = (organizationId: string) =>
    requester(
      testApp({ "/": objects }, { organizationId, userId: "user" }),
      bindings,
    );
  return {
    database,
    first: appFor("org_user-1"),
    second: appFor("organization-2"),
    stored,
  };
}

function addSecondOrganization(
  database: ReturnType<typeof createTestDatabase>,
) {
  const createdAt = "2026-08-19T12:00:00.000Z";
  seedOrganization(database, {
    createdAt,
    id: "organization-2",
    name: "Another Organization",
    slug: "another-organization",
  });
  seedUser(database, {
    defaultOrganizationId: "organization-2",
    email: "another@example.com",
    emailVerified: false,
    id: "user-2",
    name: "Another Person",
  });
  seedMember(database, {
    createdAt,
    id: "member-2",
    organizationId: "organization-2",
    role: "owner",
    userId: "user-2",
  });
  database
    .query(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "other-object",
      "organization-2",
      "organizations/organization-2/uploads/other/file.txt",
      "file.txt",
      "text/plain",
      4,
      createdAt,
    );
}
