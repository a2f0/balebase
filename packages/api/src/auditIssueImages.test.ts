import { describe, expect, it } from "bun:test";
import { purgePendingAuditIssueImages } from "./auditIssueImageCleanup";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import {
  createFixture,
  decodeImageFixture,
  type IssueImageResponse,
  imagesFor,
  imageUpload,
  pngBytes,
} from "./testing/auditFixture";

describe("audit issue images", () => {
  it("normalizes and stores every supported issue image format", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('format-audit', 'org_user-1', 'Format test', '{}', '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO issues
         (target_type, id, organization_id, target_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('audit_run', 'format-issue', 'org_user-1', 'format-audit', 'item',
                 'Format test issue', 'user-1', ?, ?)`,
      )
      .run(now, now);

    const formats = [
      {
        bytes: pngBytes(),
        contentType: "image/png",
        extension: "png",
      },
      {
        bytes: jpegBytes(),
        contentType: "image/jpeg",
        extension: "jpg",
      },
      {
        bytes: gifBytes(),
        contentType: "image/gif",
        extension: "gif",
      },
      {
        bytes: webpBytes(),
        contentType: "image/webp",
        extension: "webp",
      },
    ] as const;

    for (const format of formats) {
      let outputOptions: ImageOutputOptions | undefined;
      fixture.bindings.IMAGES = imagesFor({
        expectedBytes: format.bytes,
        format: format.contentType,
        onOutput: (options) => {
          outputOptions = options;
        },
      });
      const uploaded = await fixture.request(
        `/issues/format-issue/images?filename=evidence.original`,
        imageUpload(format.bytes, format.contentType),
      );
      expect(uploaded.status).toBe(201);
      const body = (await uploaded.json()) as IssueImageResponse;
      expect(body.image).toMatchObject({
        contentType: format.contentType,
        filename: `evidence.${format.extension}`,
      });
      expect(outputOptions).toEqual({
        anim: false,
        format: format.contentType,
      });

      const object = fixture.database
        .query(
          `SELECT object_key, content_type, filename, deletion_pending
           FROM objects WHERE filename = ?`,
        )
        .get(`evidence.${format.extension}`) as {
        content_type: string;
        deletion_pending: number;
        filename: string;
        object_key: string;
      };
      expect(object).toMatchObject({
        content_type: format.contentType,
        deletion_pending: 0,
        filename: `evidence.${format.extension}`,
      });
      expect(fixture.stored.get(object.object_key)).toEqual(format.bytes);

      const storedImage = await fixture.request(
        `/issues/format-issue/images/${body.image.id}`,
        undefined,
      );
      expect(storedImage.status).toBe(200);
      expect(storedImage.headers.get("content-type")).toBe(format.contentType);
    }

    const emojiBytes = pngBytes();
    fixture.bindings.IMAGES = imagesFor({
      expectedBytes: emojiBytes,
      format: "image/png",
    });
    const longUnicodeName = `${"😀".repeat(255)}.original`;
    const unicodeUpload = await fixture.request(
      `/issues/format-issue/images?${new URLSearchParams({
        filename: longUnicodeName,
      })}`,
      imageUpload(emojiBytes, "image/png"),
    );
    expect(unicodeUpload.status).toBe(201);
    const unicodeBody = (await unicodeUpload.json()) as IssueImageResponse;
    expect(unicodeBody.image.filename).toBe(`${"😀".repeat(62)}.png`);
    expect(
      new TextEncoder().encode(unicodeBody.image.filename).byteLength,
    ).toBe(252);
    expect(() => encodeURIComponent(unicodeBody.image.filename)).not.toThrow();
  });

  it("checks a declared image type, ignoring case, and refuses empty images", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('declared-audit', 'org_user-1', 'Declared types', '{}', '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO issues
         (target_type, id, organization_id, target_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('audit_run', 'declared-issue', 'org_user-1', 'declared-audit',
                 'item', 'Declared type issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    const upload = (body: Uint8Array, contentType: string) =>
      fixture.request(
        "/issues/declared-issue/images?filename=evidence.png",
        imageUpload(body, contentType),
      );

    for (const contentType of ["", "png", "text/plain"]) {
      const refused = await upload(pngBytes(), contentType);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "Images must be JPEG, PNG, GIF, or WebP files.",
      });
    }
    expect((await upload(new Uint8Array(), "image/png")).status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    for (const contentType of ["IMAGE/PNG", "application/octet-stream"]) {
      expect((await upload(pngBytes(), contentType)).status).toBe(201);
    }
    expect(fixture.stored.size).toBe(2);
  });

  it("bounds concurrent maximum-size image upload memory", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    for (const [suffix, organizationId, userId] of [
      ["one", "org_user-1", "user-1"],
      ["two", "org_user-2", "user-2"],
    ] as const) {
      fixture.database
        .query(
          `INSERT INTO audits
           (id, organization_id, template_name, definition, responses, status,
            started_by, created_at, updated_at)
           VALUES (?, ?, 'Memory test', '{}', '{}', 'in_progress', ?, ?, ?)`,
        )
        .run(`memory-audit-${suffix}`, organizationId, userId, now, now);
      fixture.database
        .query(
          `INSERT INTO issues
           (target_type, id, organization_id, target_id, item_id, title, created_by,
            created_at, updated_at)
           VALUES ('audit_run', ?, ?, ?, 'item', 'Memory test issue', ?, ?, ?)`,
        )
        .run(
          `memory-issue-${suffix}`,
          organizationId,
          `memory-audit-${suffix}`,
          userId,
          now,
          now,
        );
    }
    const maximumImage = new Uint8Array(10 * 1024 * 1024);
    maximumImage.set(pngBytes());
    let processing = 0;
    let releaseProcessing: (() => void) | undefined;
    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    fixture.bindings.IMAGES = imagesFor({
      expectedBytes: maximumImage,
      normalizedBytes: pngBytes(),
      onInfo: async () => {
        processing += 1;
        if (processing === 2) queueMicrotask(() => releaseProcessing?.());
        await processingGate;
      },
    });

    const uploads = await Promise.all([
      fixture.request(
        "/issues/memory-issue-one/images?filename=one-a.png",
        imageUpload(maximumImage),
      ),
      fixture.request(
        "/issues/memory-issue-one/images?filename=one-b.png",
        imageUpload(maximumImage),
      ),
      fixture.request(
        "/issues/memory-issue-two/images?filename=two.png",
        imageUpload(maximumImage, "image/png", {
          "x-test-organization-id": "org_user-2",
          "x-test-user-id": "user-2",
        }),
      ),
    ]);

    expect(uploads.filter(({ status }) => status === 201)).toHaveLength(2);
    expect(uploads.filter(({ status }) => status === 429)).toHaveLength(1);
    expect(uploads[2]?.status).toBe(201);
    expect(
      uploads.slice(0, 2).filter(({ status }) => status === 201),
    ).toHaveLength(1);
    expect(
      uploads.slice(0, 2).filter(({ status }) => status === 429),
    ).toHaveLength(1);
    expect(processing).toBe(2);
  });

  it("tombstones image objects when an issue is cascade-deleted", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    const definition = JSON.stringify({ sections: [], version: 1 });
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_id, template_name, definition,
          responses, status, started_by, created_at, updated_at)
         VALUES ('cascade-audit', 'org_user-1', NULL, 'Cascade audit', ?, '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(definition, now, now);
    fixture.database
      .query(
        `INSERT INTO issues
         (target_type, id, organization_id, target_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('audit_run', 'cascade-issue', 'org_user-1', 'cascade-audit', 'item-1',
                 'Cascade issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending)
         VALUES ('cascade-object', 'org_user-1', 'cascade/image', 'image.png',
                 'image/png', 3, ?, 'audit_issue_image', 0)`,
      )
      .run(now);
    fixture.database
      .query(
        `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, slot, created_at)
         VALUES ('cascade-image', 'cascade-issue', 'cascade-object', 'user-1',
                 1, ?)`,
      )
      .run(now);
    fixture.stored.set("cascade/image", Uint8Array.from([1, 2, 3]));
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM issues WHERE id = 'cascade-issue'`)
      .run();

    expect(
      fixture.database
        .query(`SELECT id FROM audit_issue_images WHERE id = 'cascade-image'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending, cleanup_token, upload_token
           FROM objects WHERE id = 'cascade-object'`,
        )
        .get(),
    ).toEqual({
      cleanup_token: null,
      deletion_pending: 1,
      upload_token: null,
    });
    expect(await purgePendingAuditIssueImages(fixture.bindings, now)).toBe(1);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(`SELECT id FROM objects WHERE id = 'cascade-object'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'cascade-object'`,
        )
        .get(),
    ).toBeNull();

    fixture.database
      .query(
        `INSERT INTO issues
         (target_type, id, organization_id, target_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('audit_run', 'upload-race-issue', 'org_user-1', 'cascade-audit', 'item-2',
                 'Upload race issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(`DELETE FROM issues WHERE id = 'upload-race-issue'`)
        .run();
    };

    const racedUpload = await fixture.request(
      "/issues/upload-race-issue/images?filename=race.png",
      imageUpload(pngBytes()),
    );

    expect(racedUpload.status).toBe(500);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM objects
           WHERE kind = 'audit_issue_image'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM deleted_object_cleanup`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains R2 cleanup after an organization is hard-deleted", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('purged-audit', 'org_user-1', 'Purged audit', '{}', '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO issues
         (target_type, id, organization_id, target_id, item_id, title, created_by,
          created_at, updated_at)
         VALUES ('audit_run', 'purged-issue', 'org_user-1', 'purged-audit', 'item-1',
                 'Purged issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending)
         VALUES ('purged-object', 'org_user-1', 'purged/image', 'image.png',
                 'image/png', 3, ?, 'audit_issue_image', 0)`,
      )
      .run(now);
    fixture.database
      .query(
        `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, slot, created_at)
         VALUES ('purged-image', 'purged-issue', 'purged-object', 'user-1',
                 1, ?)`,
      )
      .run(now);
    fixture.stored.set("purged/image", Uint8Array.from([1, 2, 3]));
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM organization WHERE id = 'org_user-1'`)
      .run();

    expect(
      fixture.database
        .query(`SELECT id FROM objects WHERE id = 'purged-object'`)
        .get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT id, organization_id, object_key FROM deleted_object_cleanup
           WHERE id = 'purged-object'`,
        )
        .get(),
    ).toEqual({
      id: "purged-object",
      object_key: "purged/image",
      organization_id: "org_user-1",
    });
    expect(fixture.stored.has("purged/image")).toBe(true);

    fixture.storageControl.failNextDelete = true;
    const eligibleCutoffs = {
      abandonedClaimedBefore: "9999-12-31T23:59:59.999Z",
      deletedBefore: "9999-12-31T23:59:59.999Z",
    };
    await expect(
      purgeDeletedObjects(fixture.bindings, eligibleCutoffs),
    ).rejects.toThrow("Transient R2 delete failure");
    expect(
      fixture.database
        .query(
          `SELECT cleanup_token FROM deleted_object_cleanup
           WHERE id = 'purged-object'`,
        )
        .get(),
    ).toEqual({ cleanup_token: expect.any(String) });
    expect(fixture.stored.has("purged/image")).toBe(true);

    expect(await purgeDeletedObjects(fixture.bindings, eligibleCutoffs)).toBe(
      1,
    );
    expect(fixture.stored.has("purged/image")).toBe(false);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'purged-object'`,
        )
        .get(),
    ).toBeNull();
  });

  it("waits out in-flight uploads before purging deleted organizations", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending, upload_token,
          upload_lease_expires_at)
         VALUES ('raced-object', 'org_user-1', 'raced/image', 'image.png',
                 'image/png', 0, ?, 'audit_issue_image', 1, 'upload-token',
                 '9999-12-31T23:59:59.999Z')`,
      )
      .run(now);
    fixture.database.exec("PRAGMA foreign_keys = ON");

    fixture.database
      .query(`DELETE FROM organization WHERE id = 'org_user-1'`)
      .run();

    expect(await purgeDeletedObjects(fixture.bindings)).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'raced-object'`,
        )
        .get(),
    ).toEqual({ id: "raced-object" });

    // Model the request finishing its R2 write and crashing before activation.
    fixture.stored.set("raced/image", Uint8Array.from([1, 2, 3]));
    expect(
      await purgeDeletedObjects(fixture.bindings, {
        abandonedClaimedBefore: "9999-12-31T23:59:59.999Z",
        deletedBefore: "9999-12-31T23:59:59.999Z",
      }),
    ).toBe(1);
    expect(fixture.stored.has("raced/image")).toBe(false);
    expect(
      fixture.database
        .query(
          `SELECT id FROM deleted_object_cleanup WHERE id = 'raced-object'`,
        )
        .get(),
    ).toBeNull();
  });
});

function jpegBytes() {
  return decodeImageFixture(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  );
}

function gifBytes() {
  return decodeImageFixture("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
}

function webpBytes() {
  return decodeImageFixture(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  );
}
