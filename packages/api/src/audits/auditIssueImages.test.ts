import { describe, expect, it } from "bun:test";
import { purgeDeletedObjects } from "../library/deletedObjectCleanup";
import {
  createAuditIssue,
  createFixture,
  decodeImageFixture,
  type IssueImageResponse,
  imageActivation,
  imagesFor,
  imageUpload,
  pngBytes,
} from "../testing/auditFixture";
import { purgePendingAuditIssueImages } from "./auditIssueImageCleanup";

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

  it("refuses invalid, truncated, and oversized images without storing them", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    const invalidImage = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=fake.png`,
      imageUpload("not an image"),
    );
    expect(invalidImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    const truncatedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=truncated.png`,
      imageUpload(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    );
    expect(truncatedImage.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    fixture.bindings.IMAGES = imagesFor({ width: 12_001 });
    const oversizedDimensions = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=too-wide.png`,
      imageUpload(pngBytes(), "application/octet-stream"),
    );
    expect(oversizedDimensions.status).toBe(400);
    expect(fixture.stored.size).toBe(0);

    fixture.bindings.IMAGES = imagesFor({
      normalizedBytes: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    const oversizedNormalizedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=oversized-output.png`,
      imageUpload(pngBytes()),
    );
    expect(oversizedNormalizedImage.status).toBe(413);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("normalizes an image's type and name and serves it privately with a thumbnail", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    const uploaded = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=electrical-panel.jpg`,
      imageUpload(pngBytes(), "image/jpeg"),
    );
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as IssueImageResponse;
    expect(uploadedBody.image).toMatchObject({
      contentType: "image/png",
      filename: "electrical-panel.png",
    });

    const hiddenImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      {
        headers: {
          "x-test-organization-id": "org_user-2",
          "x-test-user-id": "user-2",
        },
      },
    );
    expect(hiddenImage.status).toBe(404);

    const image = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toContain("inline");

    let thumbnailTransform: Record<string, unknown> | undefined;
    fixture.bindings.IMAGES = imagesFor({
      onTransform: (options) => {
        thumbnailTransform = options;
      },
    });
    const thumbnail = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}?variant=thumbnail`,
      undefined,
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("cache-control")).toBe("no-store");
    expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    expect(thumbnailTransform).toEqual({
      fit: "scale-down",
      height: 480,
      width: 480,
    });
  });

  it("keeps an image whose activation committed but lost its response", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    const lostActivation = fixture.hooks.after(imageActivation, () => {
      throw new Error("D1 activation response was lost after commit");
    });
    const pendingUpdate = fixture.hooks.before(
      "SET deletion_pending = 1",
      failPendingUpdate,
    );
    const committedWithoutResponse = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=committed-without-response.png`,
      imageUpload(pngBytes()),
    );
    expect(committedWithoutResponse.status).toBe(201);
    const committedWithoutResponseBody =
      (await committedWithoutResponse.json()) as IssueImageResponse;
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending FROM objects
           WHERE filename = 'committed-without-response.png'`,
        )
        .get(),
    ).toEqual({ deletion_pending: 0 });
    expect(fixture.stored.size).toBe(1);
    const retainedCommittedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${committedWithoutResponseBody.image.id}`,
      undefined,
    );
    expect(retainedCommittedImage.status).toBe(200);
    expect(lostActivation.calls).toBe(1);
    expect(pendingUpdate.calls).toBe(0);
    pendingUpdate.remove();
    const deletedCommittedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${committedWithoutResponseBody.image.id}`,
      { method: "DELETE" },
    );
    expect(deletedCommittedImage.status).toBe(204);
    expect(fixture.stored.size).toBe(0);
  });

  it("keeps a leased upload from cleanup while its bytes are written", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(
          `UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z'
           WHERE filename = 'lease-protected.png'`,
        )
        .run();
      expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
      expect(
        fixture.database
          .query(
            `SELECT cleanup_token, upload_token,
                    datetime(upload_lease_expires_at) > datetime('now') AS leased
             FROM objects WHERE filename = 'lease-protected.png'`,
          )
          .get(),
      ).toEqual({
        cleanup_token: null,
        leased: 1,
        upload_token: expect.any(String),
      });
    };
    const leaseProtectedUpload = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=lease-protected.png`,
      imageUpload(pngBytes()),
    );
    expect(leaseProtectedUpload.status).toBe(201);
    const leaseProtectedBody =
      (await leaseProtectedUpload.json()) as IssueImageResponse;
    const deletedLeaseProtectedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${leaseProtectedBody.image.id}`,
      { method: "DELETE" },
    );
    expect(deletedLeaseProtectedImage.status).toBe(204);
    expect(fixture.stored.size).toBe(0);
  });

  it("refuses an upload whose lease expired while its bytes were written", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    fixture.storageControl.beforeNextPut = async () => {
      fixture.database
        .query(
          `UPDATE objects
           SET created_at = '2000-01-01T00:00:00.000Z',
               upload_lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE filename = 'expired-mid-write.png'`,
        )
        .run();
      expect(
        await purgePendingAuditIssueImages(
          fixture.bindings,
          "9999-12-31T23:59:59.999Z",
          "9999-12-31T23:59:59.999Z",
        ),
      ).toBe(1);
    };
    const expiredMidWriteUpload = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=expired-mid-write.png`,
      imageUpload(pngBytes()),
    );
    expect(expiredMidWriteUpload.status).toBe(500);
    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT id FROM objects WHERE filename = 'expired-mid-write.png'`,
        )
        .get(),
    ).toBeNull();
  });

  it("retries a failed upload's cleanup and spares an object reclaimed meanwhile", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    fixture.hooks.before(imageActivation, () => {
      throw new Error("Transient D1 image activation failure");
    });
    fixture.storageControl.failNextDelete = true;
    const failedUploadCleanup = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=cleanup-retry.png`,
      imageUpload(pngBytes()),
    );
    expect(failedUploadCleanup.status).toBe(500);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM objects
           WHERE deletion_pending = 1 AND kind = 'audit_issue_image'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
    fixture.hooks.before(
      "SET cleanup_token = ?",
      ({ values }) => {
        const objectId = values[2];
        if (typeof objectId !== "string") {
          throw new Error("Cleanup claim object id missing");
        }
        fixture.database
          .query(
            `UPDATE objects
             SET deletion_pending = 0, cleanup_token = NULL,
                 cleanup_claimed_at = NULL, upload_token = NULL,
                 upload_lease_expires_at = NULL
             WHERE id = ?`,
          )
          .run(objectId);
      },
      { method: "first" },
    );
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(0);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT cleanup_token, deletion_pending FROM objects
           WHERE filename = 'cleanup-retry.png'`,
        )
        .get(),
    ).toEqual({ cleanup_token: null, deletion_pending: 0 });
    fixture.database
      .query(
        `UPDATE objects SET deletion_pending = 1
         WHERE filename = 'cleanup-retry.png'`,
      )
      .run();
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(0);
  });

  it("admits one upload to an issue at a time and caps it at ten images", async () => {
    const fixture = createFixture();
    const { auditId, issue } = await createAuditIssue(fixture);
    const uploaded = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=electrical-panel.jpg`,
      imageUpload(pngBytes(), "image/jpeg"),
    );
    expect(uploaded.status).toBe(201);

    let processedConcurrentUploads = 0;
    fixture.bindings.IMAGES = imagesFor({
      onInfo: () => {
        processedConcurrentUploads += 1;
      },
    });
    const concurrentUploads = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.request(
          `/issues/${issue.body.issueId}/images?filename=concurrent-${index}.png`,
          imageUpload(pngBytes()),
        ),
      ),
    );
    expect(
      concurrentUploads.filter(({ status }) => status === 201),
    ).toHaveLength(1);
    expect(
      concurrentUploads.filter(({ status }) => status === 429),
    ).toHaveLength(9);
    expect(
      concurrentUploads
        .filter(({ status }) => status === 429)
        .every((response) => response.headers.get("retry-after") === "1"),
    ).toBe(true);
    const retriedUploads: Response[] = [];
    for (let index = 0; index < 9; index += 1) {
      retriedUploads.push(
        await fixture.request(
          `/issues/${issue.body.issueId}/images?filename=retry-${index}.png`,
          imageUpload(pngBytes()),
        ),
      );
    }
    expect(retriedUploads.filter(({ status }) => status === 201)).toHaveLength(
      8,
    );
    expect(retriedUploads.filter(({ status }) => status === 409)).toHaveLength(
      1,
    );
    expect(processedConcurrentUploads).toBe(9);
    expect(fixture.stored.size).toBe(10);
    expect(
      fixture.database
        .query(`SELECT COUNT(*) AS count FROM audit_issue_images`)
        .get(),
    ).toEqual({ count: 10 });
    expect(
      fixture.database.query(`SELECT COUNT(*) AS count FROM objects`).get(),
    ).toEqual({ count: 10 });
    expect(
      fixture.database.query(`SELECT DISTINCT kind FROM objects`).all(),
    ).toEqual([{ kind: "audit_issue_image" }]);

    const rejectedBeforeProcessing = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=invalid.png`,
      imageUpload("not an image"),
    );
    expect(rejectedBeforeProcessing.status).toBe(409);
    expect(fixture.stored.size).toBe(10);

    const detail = await fixture.request(`/runs/${auditId}`, undefined);
    const detailBody = (await detail.json()) as {
      issues: Array<{
        images: Array<{
          contentType: string;
          filename: string;
          id: string;
          uploadedBy: { id: string };
        }>;
      }>;
    };
    expect(detailBody.issues[0]?.images).toHaveLength(10);
    expect(detailBody.issues[0]?.images).toContainEqual(
      expect.objectContaining({
        contentType: "image/png",
        filename: "electrical-panel.png",
        uploadedBy: expect.objectContaining({ id: "user-1" }),
      }),
    );

    const deletedImages = await Promise.all(
      (detailBody.issues[0]?.images ?? []).map(({ id }) =>
        fixture.request(`/issues/${issue.body.issueId}/images/${id}`, {
          method: "DELETE",
        }),
      ),
    );
    expect(deletedImages.every(({ status }) => status === 204)).toBe(true);
    expect(fixture.stored.size).toBe(0);
  });

  it("keeps an image when marking it for deletion fails", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    const uploaded = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=electrical-panel.jpg`,
      imageUpload(pngBytes(), "image/jpeg"),
    );
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as IssueImageResponse;
    fixture.hooks.before("SET deletion_pending = 1", failPendingUpdate);
    const failedMetadataDelete = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
    );
    expect(failedMetadataDelete.status).toBe(500);
    expect(fixture.stored.size).toBe(1);
    const retainedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
    );
    expect(retainedImage.status).toBe(200);
  });

  it("hides an image whose bytes could not be deleted and purges them later", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    const uploaded = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=electrical-panel.jpg`,
      imageUpload(pngBytes(), "image/jpeg"),
    );
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as IssueImageResponse;

    const uploadedObject = fixture.database
      .query(`SELECT id FROM objects WHERE filename = 'electrical-panel.png'`)
      .get() as { id: string };
    fixture.storageControl.failNextDelete = true;
    const failedImageDelete = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
    );
    expect(failedImageDelete.status).toBe(202);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT deletion_pending FROM objects
           WHERE id = ? AND kind = 'audit_issue_image'`,
        )
        .get(uploadedObject.id),
    ).toEqual({ deletion_pending: 1 });
    expect(
      fixture.database
        .query(`SELECT id FROM audit_issue_images WHERE id = ?`)
        .get(uploadedBody.image.id),
    ).toBeNull();
    const pendingImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
    );
    expect(pendingImage.status).toBe(404);
    const replacementImage = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=replacement.png`,
      imageUpload(pngBytes()),
    );
    expect(replacementImage.status).toBe(201);
    const replacementImageBody =
      (await replacementImage.json()) as IssueImageResponse;
    expect(fixture.stored.size).toBe(2);
    expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(1);

    const deletedReplacement = await fixture.request(
      `/issues/${issue.body.issueId}/images/${replacementImageBody.image.id}`,
      { method: "DELETE" },
    );
    expect(deletedReplacement.status).toBe(204);
    expect(fixture.stored.size).toBe(0);
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

function failPendingUpdate(): never {
  throw new Error("Transient D1 update failure");
}
