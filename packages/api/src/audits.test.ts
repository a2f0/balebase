import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { purgePendingAuditIssueImages } from "./auditIssueImageCleanup";
import {
  auditTarget,
  createActivityAudit,
  createFixture,
  type IssueImageResponse,
  type IssueResponse,
  imageActivation,
  imagesFor,
  imageUpload,
  jsonRequest,
  pngBytes,
  type RunListResponse,
  type RunResponse,
  type TemplateListResponse,
  type TemplateResponse,
  type TestIdentity,
} from "./testing/auditFixture";

describe("audits", () => {
  it("paginates every retained audit run with a stable cursor", async () => {
    const fixture = createFixture();
    const insert = fixture.database.query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, 'org_user-1', 'History test', ?, '{}', 'completed',
               'user-1', ?, ?)`,
    );
    const definition = JSON.stringify({
      sections: [{ id: "section", items: [], title: "History" }],
      version: 1,
    });
    for (let index = 0; index < 105; index += 1) {
      const createdAt = new Date(
        Date.UTC(2026, 7, 1, 0, 0, index),
      ).toISOString();
      insert.run(
        `history-${index.toString().padStart(3, "0")}`,
        definition,
        createdAt,
        createdAt,
      );
    }

    const first = await jsonRequest<RunListResponse>(fixture, "/runs", "GET");
    expect(first.status).toBe(200);
    expect(first.body.audits).toHaveLength(100);
    expect(first.body.nextCursor).toBeString();

    const second = await jsonRequest<RunListResponse>(
      fixture,
      `/runs?cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
      "GET",
    );
    expect(second.status).toBe(200);
    expect(second.body.audits).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.audits, ...second.body.audits].map(
      ({ id }) => id,
    );
    expect(ids).toHaveLength(105);
    expect(new Set(ids)).toHaveLength(105);
    expect(ids[0]).toBe("history-104");
    expect(ids.at(-1)).toBe("history-000");

    const invalid = await jsonRequest(fixture, "/runs?cursor=not-valid", "GET");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Invalid audit cursor." });
  });

  it("reports an audit removed during an update as missing", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('update-race', 'org_user-1', 'Race test', ?, '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(
        JSON.stringify({
          sections: [{ id: "section", items: [], title: "Race" }],
          version: 1,
        }),
        now,
        now,
      );
    fixture.hooks.before("UPDATE audits SET responses", (event) => {
      const { auditId, organizationId } = auditTarget(event);
      fixture.database
        .query("DELETE FROM audits WHERE id = ? AND organization_id = ?")
        .run(auditId, organizationId);
    });

    const updated = await jsonRequest(fixture, "/runs/update-race", "PATCH", {
      expectedRevision: 0,
      responses: {},
      status: "in_progress",
    });

    expect(updated.status).toBe(404);
    expect(updated.body).toEqual({ error: "Audit not found." });
  });

  it("creates templates, snapshots audit runs, and tracks assigned issues", async () => {
    const fixture = createFixture();
    const starterResponse = await fixture.request("/templates", undefined);
    expect(starterResponse.status).toBe(200);
    const starterBody = (await starterResponse.json()) as TemplateListResponse;
    expect(starterBody.templates).toHaveLength(2);
    const nfpaStarter = starterBody.templates.find(
      ({ id }) => id === "nfpa70e_global",
    );
    expect(nfpaStarter).toMatchObject({
      id: "nfpa70e_global",
      name: "NFPA 70E readiness checklist",
      scope: "global",
    });
    expect(nfpaStarter?.definition.sections).toHaveLength(6);
    const residentialStarter = starterBody.templates.find(
      ({ id }) => id === "us_residential_core_global",
    );
    expect(residentialStarter).toMatchObject({
      name: "U.S. residential construction — comprehensive baseline",
      scope: "global",
    });
    expect(residentialStarter?.definition.sections.length).toBeGreaterThan(15);
    expect(
      residentialStarter?.definition.sections.reduce(
        (count, section) => count + section.items.length,
        0,
      ),
    ).toBeGreaterThanOrEqual(225);

    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walkthrough" },
    );
    expect(created.status).toBe(201);
    const template = created.body.template;
    expect(template).toMatchObject({
      currentVersion: 1,
      scope: "organization",
      version: 1,
    });
    template.definition.sections[0]?.items.push({
      id: "notes-item",
      prompt: "Record observations",
      required: false,
      responseType: "text",
    });

    const updated = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${template.id}`,
      "PUT",
      {
        definition: template.definition,
        description: "A small operational checklist.",
        name: template.name,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.template).toMatchObject({
      currentVersion: 2,
      version: 2,
    });

    const started = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${template.id}/runs`,
      "POST",
    );
    expect(started.status).toBe(201);

    const incomplete = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { expectedRevision: 0, responses: {}, status: "completed" },
    );
    expect(incomplete.status).toBe(400);

    const firstItem = template.definition.sections[0]?.items[0];
    expect(firstItem).toBeDefined();
    const saved = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      {
        expectedRevision: 0,
        responses: { [firstItem?.id ?? ""]: "fail" },
        status: "in_progress",
      },
    );
    expect(saved.status).toBe(200);

    const issue = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${started.body.auditId}/issues`,
      "POST",
      {
        assignedTo: "user-1",
        description: "Correct before the next shift.",
        itemId: firstItem?.id,
        priority: "high",
        title: firstItem?.prompt,
      },
    );
    expect(issue.status).toBe(201);

    const invalidAssignee = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(invalidAssignee.status).toBe(400);

    fixture.database
      .query(
        `INSERT INTO member
         (id, organizationId, userId, role, createdAt)
         VALUES ('member-user-2-org-1', 'org_user-1', 'user-2', 'member', ?)`,
      )
      .run("2026-08-25T12:00:00.000Z");
    fixture.hooks.before(
      /UPDATE issues[\s\S]*SELECT 1 FROM member/,
      ({ values }) => {
        fixtureMemberDeletion(fixture.database, values.at(-2), values.at(-1));
      },
    );
    const removedDuringAssignment = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(removedDuringAssignment.status).toBe(400);
    expect(
      fixture.database
        .query(`SELECT assigned_to FROM issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1" });

    const unassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: null },
    );
    expect(unassigned.status).toBe(200);
    const reassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-1" },
    );
    expect(reassigned.status).toBe(200);

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
    fixture.bindings.IMAGES = imagesFor();

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
    expect(fixture.stored.size).toBe(2);
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
    expect(fixture.stored.size).toBe(1);

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
    expect(fixture.stored.size).toBe(1);

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
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database
        .query(
          `SELECT id FROM objects WHERE filename = 'expired-mid-write.png'`,
        )
        .get(),
    ).toBeNull();

    fixture.hooks.before(imageActivation, () => {
      throw new Error("Transient D1 image activation failure");
    });
    fixture.storageControl.failNextDelete = true;
    const failedUploadCleanup = await fixture.request(
      `/issues/${issue.body.issueId}/images?filename=cleanup-retry.png`,
      imageUpload(pngBytes()),
    );
    expect(failedUploadCleanup.status).toBe(500);
    expect(fixture.stored.size).toBe(2);
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
    expect(fixture.stored.size).toBe(2);
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
    expect(fixture.stored.size).toBe(1);

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

    const detail = await fixture.request(
      `/runs/${started.body.auditId}`,
      undefined,
    );
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
    expect(detailBody).toMatchObject({
      audit: {
        responses: { [firstItem?.id ?? ""]: "fail" },
        templateId: template.id,
        templateVersion: 2,
      },
      issues: [
        {
          assignedTo: "user-1",
          assigneeName: "Example Person",
          description: "Correct before the next shift.",
          priority: "high",
          status: "open",
        },
      ],
      members: [{ id: "user-1", name: "Example Person" }],
    });
    expect(detailBody.issues[0]?.images).toHaveLength(10);
    expect(detailBody.issues[0]?.images).toContainEqual(
      expect.objectContaining({
        contentType: "image/png",
        filename: "electrical-panel.png",
        uploadedBy: expect.objectContaining({ id: "user-1" }),
      }),
    );

    fixture.database
      .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
      .run("org_user-1", "user-1");
    const resolved = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { status: "resolved" },
    );
    expect(resolved.status).toBe(200);
    expect(
      fixture.database
        .query(`SELECT assigned_to, status FROM issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1", status: "resolved" });

    fixture.hooks.before("SET deletion_pending = 1", failPendingUpdate);
    const failedMetadataDelete = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
    );
    expect(failedMetadataDelete.status).toBe(500);
    expect(fixture.stored.size).toBe(10);
    const retainedImage = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      undefined,
    );
    expect(retainedImage.status).toBe(200);

    const uploadedObject = fixture.database
      .query(`SELECT id FROM objects WHERE filename = 'electrical-panel.png'`)
      .get() as { id: string };
    fixture.storageControl.failNextDelete = true;
    const failedImageDelete = await fixture.request(
      `/issues/${issue.body.issueId}/images/${uploadedBody.image.id}`,
      { method: "DELETE" },
    );
    expect(failedImageDelete.status).toBe(202);
    expect(fixture.stored.size).toBe(10);
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
    expect(fixture.stored.size).toBe(11);
    expect(await purgePendingAuditIssueImages(fixture.bindings)).toBe(0);
    expect(
      await purgePendingAuditIssueImages(
        fixture.bindings,
        "9999-12-31T23:59:59.999Z",
      ),
    ).toBe(1);
    expect(fixture.stored.size).toBe(10);

    const deletedImages = await Promise.all(
      (detailBody.issues[0]?.images ?? [])
        .filter(({ id }) => id !== uploadedBody.image.id)
        .map(({ id }) =>
          fixture.request(`/issues/${issue.body.issueId}/images/${id}`, {
            method: "DELETE",
          }),
        ),
    );
    expect(deletedImages.every(({ status }) => status === 204)).toBe(true);
    const deletedReplacement = await fixture.request(
      `/issues/${issue.body.issueId}/images/${replacementImageBody.image.id}`,
      { method: "DELETE" },
    );
    expect(deletedReplacement.status).toBe(204);
    expect(fixture.stored.size).toBe(0);
  });
});

describe("audit request rules", () => {
  it("keeps each rule's message for template and answer saves", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const { auditId, templateId } = await createActivityAudit(fixture);
    const template = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${templateId}`,
      "GET",
    );
    const { definition, name } = template.body.template;
    const shared = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "Shared form" },
      admin,
    );
    const sharedId = shared.body.template.id;
    const longPrompt = structuredClone(definition);
    const firstItem = longPrompt.sections[0]?.items[0];
    if (firstItem) firstItem.prompt = "x".repeat(501);
    const cases: Array<[string, string, unknown, string, TestIdentity?]> = [
      ["POST", "/templates", { name: " " }, "A template name is required."],
      [
        "POST",
        "/templates",
        { name: "Form", scope: "global" },
        "Template scope is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition: longPrompt, name },
        "The template definition is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition: { ...definition, sections: [] }, name },
        "The template definition is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition, description: "x".repeat(2001), name },
        "Descriptions are limited to 2,000 characters.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: -1, responses: {} },
        "A valid audit revision is required. Reload it before saving.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: 0, responses: { check: 1 } },
        "Invalid audit responses.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: 0, responses: {}, status: "done" },
        "Invalid audit status.",
      ],
      [
        "PUT",
        `/admin/audit-templates/${sharedId}`,
        { definition, name, status: "draft" },
        "Template status is invalid.",
        admin,
      ],
      [
        "DELETE",
        `/admin/audit-templates/${sharedId}`,
        {},
        "The current template version is required.",
        admin,
      ],
    ];
    for (const [method, path, body, error, identity] of cases) {
      expect({
        path,
        response: await jsonRequest(fixture, path, method, body, identity),
      }).toMatchObject({ path, response: { body: { error }, status: 400 } });
    }
  });
});

describe("audit issue writes", () => {
  it("rejects an unknown priority instead of defaulting it", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture);
    const rejected = await jsonRequest(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      {
        itemId: "check",
        priority: "urgent",
        title: "Loose rail",
      },
    );
    expect(rejected).toMatchObject({
      body: { error: "Invalid issue details." },
      status: 400,
    });

    const raised = await jsonRequest<{ issueId: string }>(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      { assignedTo: " ", itemId: "check", title: " Loose rail " },
    );
    expect(raised.status).toBe(201);
    expect(
      fixture.database
        .query(
          "SELECT assigned_to, description, priority, title FROM issues WHERE id = ?",
        )
        .get(raised.body.issueId),
    ).toEqual({
      assigned_to: null,
      description: "",
      priority: "medium",
      title: "Loose rail",
    });
  });

  it("keeps a checklist item ID exactly as the form defines it", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture, " check ");
    const raised = await jsonRequest<{ issueId: string }>(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      { itemId: " check ", title: "Loose rail" },
    );
    expect(raised.status).toBe(201);
    expect(
      fixture.database
        .query("SELECT item_id FROM issues WHERE id = ?")
        .get(raised.body.issueId),
    ).toEqual({ item_id: " check " });
  });

  it("refuses an assignee who leaves after the initial read", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture);
    fixture.database
      .query(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES ('member-user-2-org-1', 'org_user-1', 'user-2', 'member', ?)`,
      )
      .run("2026-08-25T12:00:00.000Z");
    fixture.hooks.before(
      "INSERT INTO issues",
      () => fixtureMemberDeletion(fixture.database, "org_user-1", "user-2"),
      { method: "batch" },
    );
    const raised = await jsonRequest(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      {
        assignedTo: "user-2",
        itemId: "check",
        title: "Loose rail",
      },
    );
    expect(raised).toMatchObject({
      body: { error: "Issue assignee is not a member." },
      status: 400,
    });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM issues WHERE target_id = ?")
        .get(auditId),
    ).toEqual({ count: 0 });
  });
});

function failPendingUpdate(): never {
  throw new Error("Transient D1 update failure");
}

function fixtureMemberDeletion(
  database: Database,
  organizationId: SQLQueryBindings | undefined,
  userId: SQLQueryBindings | undefined,
) {
  if (typeof organizationId !== "string" || typeof userId !== "string") {
    throw new Error("Assignee membership predicate bindings are missing");
  }
  database
    .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
    .run(organizationId, userId);
}
