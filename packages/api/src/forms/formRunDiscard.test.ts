import { describe, expect, it } from "bun:test";
import {
  type ActivityResponse,
  createActivityForm,
  createFixture,
  type IssueImageResponse,
  type IssueResponse,
  imageUpload,
  jsonRequest,
  pngBytes,
  type RunListResponse,
} from "../testing/formFixture";

interface DiscardedRunListResponse {
  forms: Array<{
    deletedAt: string | null;
    deletedBy: { email: string; id: string; name: string } | null;
    id: string;
  }>;
}

interface DiscardedRunResponse {
  form: {
    deletedAt: string | null;
    deletedBy: { id: string } | null;
    responses: Record<string, string>;
  };
}

describe("form discarding", () => {
  it("moves a discarded in-progress form to the deleted view with its history", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "fail" },
      status: "in_progress",
    });

    const discarded = await jsonRequest<{ deletedAt: string }>(
      fixture,
      `/runs/${formId}`,
      "DELETE",
      undefined,
      { userId: "user-2" },
    );
    expect(discarded.status).toBe(200);
    expect(discarded.body.deletedAt).toBeString();

    const active = await jsonRequest<RunListResponse>(fixture, "/runs", "GET");
    expect(active.body.forms.map(({ id }) => id)).not.toContain(formId);
    const deleted = await jsonRequest<DiscardedRunListResponse>(
      fixture,
      "/runs?view=deleted",
      "GET",
    );
    expect(deleted.body.forms).toEqual([
      expect.objectContaining({
        deletedAt: discarded.body.deletedAt,
        deletedBy: {
          email: "second@example.com",
          id: "user-2",
          name: "Second Person",
        },
        id: formId,
        responseCount: 1,
        status: "in_progress",
      }),
    ]);

    const detail = await jsonRequest<DiscardedRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.status).toBe(200);
    expect(detail.body.form).toMatchObject({
      deletedAt: discarded.body.deletedAt,
      deletedBy: { id: "user-2" },
      responses: { check: "fail" },
    });
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(history.body.events[0]).toMatchObject({
      action: "form.discarded",
      actor: { id: "user-2" },
      subject: { id: formId, type: "form_run" },
    });

    const invalid = await jsonRequest(fixture, "/runs?view=archived", "GET");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Invalid form view." });
  });

  it("keeps a discarded form, its issues, and their images read-only", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const created = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${formId}/issues`,
      "POST",
      { itemId: "check", title: "Inspect this" },
    );
    const issueId = created.body.issueId;
    const uploaded = await fixture.request(
      `/issues/${issueId}/images?filename=evidence.png`,
      imageUpload(pngBytes()),
    );
    const image = ((await uploaded.json()) as IssueImageResponse).image;
    await jsonRequest(fixture, `/runs/${formId}`, "DELETE");

    const rejections = [
      await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
        expectedRevision: 0,
        responses: { check: "pass" },
        status: "in_progress",
      }),
      await jsonRequest(fixture, `/runs/${formId}/issues`, "POST", {
        itemId: "check",
        title: "Another issue",
      }),
      await jsonRequest(fixture, `/issues/${issueId}`, "PATCH", {
        status: "resolved",
      }),
      await jsonRequest(fixture, `/runs/${formId}`, "DELETE"),
    ];
    for (const { body, status } of rejections) {
      expect(status).toBe(409);
      expect(body).toEqual({ error: "This form was discarded." });
    }
    for (const response of [
      await fixture.request(
        `/issues/${issueId}/images?filename=late.png`,
        imageUpload(pngBytes()),
      ),
      await fixture.request(`/issues/${issueId}/images/${image.id}`, {
        method: "DELETE",
      }),
    ]) {
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: "This form was discarded." });
    }

    const viewed = await fixture.request(
      `/issues/${issueId}/images/${image.id}`,
      undefined,
    );
    expect(viewed.status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT
             (SELECT responses FROM forms WHERE id = ?) AS responses,
             (SELECT status FROM issues WHERE id = ?) AS issueStatus,
             (SELECT COUNT(*) FROM issues WHERE target_id = ?) AS issues,
             (SELECT COUNT(*) FROM form_issue_images WHERE issue_id = ?) AS images,
             (SELECT COUNT(*) FROM activity_events
              WHERE root_id = ? AND action = 'form.discarded') AS discards`,
        )
        .get(formId, issueId, formId, issueId, formId),
    ).toEqual({
      discards: 1,
      images: 1,
      issueStatus: "open",
      issues: 1,
      responses: "{}",
    });
  });

  it("discards only in-progress forms in the active organization", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const otherOrganization = await jsonRequest(
      fixture,
      `/runs/${formId}`,
      "DELETE",
      undefined,
      { organizationId: "org_user-2" },
    );
    expect(otherOrganization.status).toBe(404);
    const missing = await jsonRequest(fixture, "/runs/missing", "DELETE");
    expect(missing.status).toBe(404);

    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "pass" },
      status: "completed",
    });
    const completed = await jsonRequest(fixture, `/runs/${formId}`, "DELETE");
    expect(completed.status).toBe(409);
    expect(completed.body).toEqual({
      error: "Only in-progress forms can be discarded.",
    });
    const deleted = await jsonRequest<RunListResponse>(
      fixture,
      "/runs?view=deleted",
      "GET",
    );
    expect(deleted.body.forms).toEqual([]);
  });

  it("keeps an image when its form is discarded after the removal's initial read", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const created = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${formId}/issues`,
      "POST",
      { itemId: "check", title: "Inspect this" },
    );
    const issueId = created.body.issueId;
    const uploaded = await fixture.request(
      `/issues/${issueId}/images?filename=evidence.png`,
      imageUpload(pngBytes()),
    );
    const image = ((await uploaded.json()) as IssueImageResponse).image;
    const storedBefore = fixture.stored.size;
    fixture.hooks.after(
      "FROM form_issue_images AS image",
      () => {
        fixture.database
          .query(
            `UPDATE forms SET deleted_at = ?, deleted_by_user_id = 'user-2'
             WHERE id = ?`,
          )
          .run(new Date().toISOString(), formId);
      },
      { method: "first" },
    );

    const removed = await fixture.request(
      `/issues/${issueId}/images/${image.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(409);
    const body: unknown = await removed.json();
    expect(body).toEqual({ error: "This form was discarded." });
    expect(fixture.stored.size).toBe(storedBefore);
    expect(
      fixture.database
        .query(
          `SELECT
             (SELECT COUNT(*) FROM form_issue_images WHERE id = ?) AS images,
             (SELECT object.deletion_pending FROM form_issue_images AS image
              JOIN objects AS object ON object.id = image.object_id
              WHERE image.id = ?) AS pending,
             (SELECT COUNT(*) FROM activity_events
              WHERE root_id = ? AND action = 'form.image_removed') AS removals`,
        )
        .get(image.id, image.id, formId),
    ).toEqual({ images: 1, pending: 0, removals: 0 });
  });

  it("rejects an upload, issue update, or discard that a discard overtakes", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const created = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${formId}/issues`,
      "POST",
      { itemId: "check", title: "Inspect this" },
    );
    const issueId = created.body.issueId;
    const discardNow = () => {
      fixture.database
        .query(
          `UPDATE forms SET deleted_at = ?, deleted_by_user_id = 'user-2'
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), formId);
    };
    const restore = () => {
      fixture.database
        .query("UPDATE forms SET deleted_at = NULL WHERE id = ?")
        .run(formId);
    };
    const expectDiscarded = async (response: Response) => {
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: "This form was discarded." });
    };

    // Discarded while the bytes upload: activation refuses the image.
    fixture.storageControl.beforeNextPut = async () => discardNow();
    await expectDiscarded(
      await fixture.request(
        `/issues/${issueId}/images?filename=during.png`,
        imageUpload(pngBytes()),
      ),
    );
    // Discarded between the issue check and the reservation: no bytes upload.
    restore();
    let uploadedBytes = false;
    fixture.storageControl.beforeNextPut = async () => {
      uploadedBytes = true;
    };
    fixture.hooks.after("FROM issues AS issue", discardNow, {
      method: "first",
    });
    await expectDiscarded(
      await fixture.request(
        `/issues/${issueId}/images?filename=before.png`,
        imageUpload(pngBytes()),
      ),
    );
    expect(uploadedBytes).toBe(false);
    delete fixture.storageControl.beforeNextPut;
    restore();
    fixture.hooks.after("FROM issues AS issue", discardNow, {
      method: "first",
    });
    await expectDiscarded(
      await fixture.request(`/issues/${issueId}`, {
        body: JSON.stringify({ status: "resolved" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
    restore();
    fixture.hooks.after("FROM forms AS form", discardNow);
    await expectDiscarded(
      await fixture.request(`/runs/${formId}`, { method: "DELETE" }),
    );

    expect(fixture.stored.size).toBe(0);
    expect(
      fixture.database
        .query(
          `SELECT
             (SELECT COUNT(*) FROM form_issue_images) AS images,
             (SELECT COUNT(*) FROM objects
              WHERE kind = 'form_issue_image') AS objects,
             (SELECT status FROM issues WHERE id = ?) AS issueStatus,
             (SELECT COUNT(*) FROM activity_events
              WHERE root_id = ? AND action IN
                ('form.image_uploaded', 'form.issue_resolved',
                 'form.discarded')) AS events`,
        )
        .get(issueId, formId),
    ).toEqual({ events: 0, images: 0, issueStatus: "open", objects: 0 });
  });

  it("rejects a save or new issue when the form is discarded after the initial read", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const discardNow = () => {
      fixture.database
        .query(
          `UPDATE forms SET deleted_at = ?, deleted_by_user_id = 'user-2'
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), formId);
    };

    fixture.hooks.after("FROM forms AS form", discardNow);
    const saved = await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "pass" },
      status: "in_progress",
    });
    expect(saved.status).toBe(409);
    expect(saved.body).toEqual({ error: "This form was discarded." });

    fixture.database
      .query("UPDATE forms SET deleted_at = NULL WHERE id = ?")
      .run(formId);
    fixture.hooks.after("FROM forms AS form", discardNow);
    const raised = await jsonRequest(
      fixture,
      `/runs/${formId}/issues`,
      "POST",
      {
        itemId: "check",
        title: "Too late",
      },
    );
    expect(raised.status).toBe(409);
    expect(raised.body).toEqual({ error: "This form was discarded." });
    expect(
      fixture.database
        .query("SELECT responses, revision FROM forms WHERE id = ?")
        .get(formId),
    ).toEqual({ responses: "{}", revision: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM issues WHERE target_id = ?")
        .get(formId),
    ).toEqual({ count: 0 });
  });
});
