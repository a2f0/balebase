import { describe, expect, it } from "bun:test";
import {
  type ActivityResponse,
  createActivityForm,
  createFixture,
  formTarget,
  type IssueImageResponse,
  type IssueResponse,
  imageUpload,
  jsonRequest,
  pngBytes,
  type TemplateResponse,
} from "../testing/formFixture";

interface ActivityRunResponse {
  form: {
    answerActivity: Record<string, { actor: { id: string } }>;
    completedAt: string | null;
    createdBy: { id: string };
    responses: Record<string, string>;
    revision: number;
  };
  issues: Array<{ createdBy: { id: string } }>;
}

describe("form activity", () => {
  it("attributes a template's creation and each saved version", async () => {
    const fixture = createFixture();
    const { templateId } = await createActivityForm(fixture);
    const templateHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${templateId}/activity`,
      "GET",
    );
    expect(
      templateHistory.body.events.map(({ action, actor }) => [
        action,
        actor.id,
      ]),
    ).toEqual([
      ["form.template_version_saved", "user-2"],
      ["form.template_created", "user-1"],
    ]);
  });

  it("records every answer change with its editor and previous value", async () => {
    const fixture = createFixture();
    const formId = await answeredForm(fixture);
    const beforeComplete = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(beforeComplete.body.events).toHaveLength(5);
    expect(beforeComplete.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "form.answer_changed",
          actor: expect.objectContaining({ id: "user-2" }),
          details: {
            prompt: "Check question",
            responseType: "check",
            before: null,
            after: "pass",
          },
        }),
        expect.objectContaining({
          action: "form.answer_changed",
          actor: expect.objectContaining({ id: "user-1" }),
          details: {
            prompt: "Check question",
            responseType: "check",
            before: "pass",
            after: "fail",
          },
        }),
        expect.objectContaining({
          action: "form.answer_changed",
          details: {
            prompt: "Written question",
            responseType: "text",
            before: "Initial note",
            after: null,
          },
        }),
      ]),
    );
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.form.createdBy.id).toBe("user-1");
    expect(detail.body.form.answerActivity).toMatchObject({
      check: { actor: { id: "user-1" } },
      text: { actor: { id: "user-1" } },
    });
  });

  it("records completion once and reopening with durable actor snapshots", async () => {
    const fixture = createFixture();
    const formId = await answeredForm(fixture);
    await jsonRequest(
      fixture,
      `/runs/${formId}`,
      "PATCH",
      {
        expectedRevision: 2,
        responses: { check: "fail" },
        status: "completed",
      },
      { userId: "user-2" },
    );
    const completed = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 3,
      responses: { check: "fail" },
      status: "completed",
    });
    const repeated = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(repeated.body.form.completedAt).toBe(
      completed.body.form.completedAt,
    );
    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 4,
      responses: { check: "fail" },
      status: "in_progress",
    });
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(history.body.events).toHaveLength(7);
    expect(
      history.body.events
        .slice(0, 2)
        .map(({ action, actor }) => [action, actor.id]),
    ).toEqual([
      ["form.reopened", "user-1"],
      ["form.completed", "user-2"],
    ]);
    fixture.database
      .query(
        "UPDATE user SET name = 'Renamed person', email = 'new@example.com' WHERE id = 'user-2'",
      )
      .run();
    const renamedHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(
      renamedHistory.body.events.find(
        ({ action }) => action === "form.completed",
      )?.actor,
    ).toEqual({
      apiKey: null,
      email: "second@example.com",
      id: "user-2",
      name: "Second Person",
      source: null,
      type: "user",
    });
  });

  it("records issue and image actions, but excludes failed uploads and unchanged issue updates", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const created = await jsonRequest<IssueResponse>(
      fixture,
      `/runs/${formId}/issues`,
      "POST",
      {
        assignedTo: "user-1",
        description: "Follow-up needed",
        itemId: "check",
        priority: "high",
        title: "Inspect this",
      },
      { userId: "user-2" },
    );
    const issueId = created.body.issueId;
    expect(created.status).toBe(201);
    await jsonRequest(fixture, `/issues/${issueId}`, "PATCH", {
      assignedTo: null,
      status: "resolved",
    });
    await jsonRequest(fixture, `/issues/${issueId}`, "PATCH", {
      assignedTo: null,
      status: "resolved",
    });
    await jsonRequest(
      fixture,
      `/issues/${issueId}`,
      "PATCH",
      { status: "open" },
      { userId: "user-2" },
    );
    const failedUpload = await fixture.request(
      `/issues/${issueId}/images?filename=bad.png`,
      imageUpload("invalid image"),
    );
    expect(failedUpload.status).toBe(400);
    const uploaded = await fixture.request(
      `/issues/${issueId}/images?filename=evidence.png`,
      imageUpload(pngBytes()),
    );
    expect(uploaded.status).toBe(201);
    const image = ((await uploaded.json()) as IssueImageResponse).image;
    const removed = await fixture.request(
      `/issues/${issueId}/images/${image.id}`,
      { headers: { "x-test-user-id": "user-2" }, method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.issues[0]?.createdBy.id).toBe("user-2");
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "form.image_removed",
      "form.image_uploaded",
      "form.issue_reopened",
      "form.issue_assigned",
      "form.issue_resolved",
      "form.issue_created",
      "form.started",
    ]);
    expect(history.body.events[0]?.actor.id).toBe("user-2");
    expect(
      history.body.events.find(({ action }) => action === "form.issue_assigned")
        ?.details,
    ).toMatchObject({
      before: "user-1",
      beforeName: "Example Person",
      after: null,
    });
    fixture.database.query("DELETE FROM forms WHERE id = ?").run(formId);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_type = 'form_run' AND root_id = ?",
        )
        .get(formId),
    ).toEqual({ count: 0 });
  });

  it("rejects stale and invalid saves without changing answers or recording activity", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    const first = await jsonRequest(
      fixture,
      `/runs/${formId}`,
      "PATCH",
      {
        expectedRevision: 0,
        responses: { check: "pass" },
        status: "in_progress",
      },
      { userId: "user-2" },
    );
    expect(first.status).toBe(200);
    const stale = await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "fail" },
      status: "in_progress",
    });
    expect(stale.status).toBe(409);
    for (const expectedRevision of [
      undefined,
      null,
      "1",
      -1,
      1.5,
      9007199254740992,
    ]) {
      const invalidRevision = await jsonRequest(
        fixture,
        `/runs/${formId}`,
        "PATCH",
        {
          expectedRevision,
          responses: { check: "fail" },
          status: "in_progress",
        },
      );
      expect(invalidRevision.status).toBe(400);
      expect(invalidRevision.body).toEqual({
        error: "A valid form revision is required. Reload it before saving.",
      });
    }
    const invalid = await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 1,
      responses: {},
      status: "completed",
    });
    expect(invalid.status).toBe(400);
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.form.responses).toEqual({ check: "pass" });
    expect(detail.body.form.revision).toBe(1);
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(history.body.events).toHaveLength(2);
  });

  it("rejects a save when another writer changes the revision after the initial read", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    fixture.hooks.before("UPDATE forms SET responses", (event) => {
      const { formId, organizationId } = formTarget(event);
      fixture.database
        .query(
          `UPDATE forms SET responses = '{"check":"pass"}',
             revision = revision + 1, activity_actor_id = 'user-2', updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .run(new Date().toISOString(), formId, organizationId);
    });
    const rejected = await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "fail" },
      status: "completed",
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual({
      error: "This form has changed. Reload it before saving.",
    });
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.form).toMatchObject({
      responses: { check: "pass" },
      revision: 1,
      status: "in_progress",
      answerActivity: { check: { actor: { id: "user-2" } } },
    });
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(history.body.events).toHaveLength(2);
    expect(history.body.events[0]).toMatchObject({
      action: "form.answer_changed",
      actor: { id: "user-2" },
      details: { before: null, after: "pass" },
    });
    expect(history.body.events[1]?.action).toBe("form.started");
  });

  it("keeps answer values and attribution in one snapshot during concurrent saves", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 0,
      responses: { check: "pass" },
      status: "in_progress",
    });
    fixture.hooks.after("FROM forms AS form", () => {
      fixture.database
        .query(
          `UPDATE forms SET responses = '{"check":"fail"}', revision = revision + 1,
             activity_actor_id = 'user-2', updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), formId);
    });
    const snapshot = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(snapshot.body.form).toMatchObject({
      revision: 1,
      responses: { check: "pass" },
      answerActivity: { check: { actor: { id: "user-1" } } },
    });
    const latest = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(latest.body.form).toMatchObject({
      revision: 2,
      responses: { check: "fail" },
      answerActivity: { check: { actor: { id: "user-2" } } },
    });
  });

  it("isolates organization feeds and resource history while allowing shared global template history", async () => {
    const fixture = createFixture();
    const { formId, templateId } = await createActivityForm(fixture);
    const other = { organizationId: "org_user-2", userId: "user-2" };
    for (const path of [
      `/runs/${formId}/activity`,
      `/templates/${templateId}/activity`,
    ]) {
      const denied = await jsonRequest(fixture, path, "GET", undefined, other);
      expect(denied.status).toBe(404);
    }
    const ownFeed = await jsonRequest<ActivityResponse>(
      fixture,
      "/activity",
      "GET",
    );
    expect(ownFeed.body.events).toHaveLength(3);
    const otherFeed = await jsonRequest<ActivityResponse>(
      fixture,
      "/activity",
      "GET",
      undefined,
      other,
    );
    expect(otherFeed.body.events).toEqual([]);
    const global = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/form-templates",
      "POST",
      { name: "Shared template" },
      { role: "admin" },
    );
    await jsonRequest(
      fixture,
      `/admin/form-templates/${global.body.template.id}`,
      "PUT",
      {
        ...global.body.template,
        expectedCurrentVersion: 1,
        status: "published",
      },
      { role: "admin" },
    );
    const globalHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${global.body.template.id}/activity`,
      "GET",
      undefined,
      other,
    );
    expect(globalHistory.body.events.map(({ action }) => action)).toEqual([
      "form.template_published",
    ]);
    const privateHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${templateId}/activity`,
      "GET",
    );
    expect(
      privateHistory.body.events.every(({ root }) => root.id === templateId),
    ).toBe(true);
  });

  it("paginates activity without duplicates and retains attribution beyond the first page", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    await jsonRequest(
      fixture,
      `/runs/${formId}`,
      "PATCH",
      {
        expectedRevision: 0,
        responses: { check: "pass" },
        status: "in_progress",
      },
      { userId: "user-2" },
    );
    for (let index = 0; index < 55; index += 1) {
      await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
        expectedRevision: index + 1,
        responses: { check: "pass", text: `Note ${index}` },
        status: "in_progress",
      });
    }
    const first = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity`,
      "GET",
    );
    expect(first.body.events).toHaveLength(50);
    expect(first.body.nextCursor).toBeString();
    await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
      expectedRevision: 56,
      responses: { check: "pass", text: "New while paging" },
      status: "in_progress",
    });
    const second = await jsonRequest<ActivityResponse>(
      fixture,
      `/runs/${formId}/activity?cursor=${first.body.nextCursor}`,
      "GET",
    );
    expect(second.body.events).toHaveLength(7);
    expect(second.body.nextCursor).toBeNull();
    expect(
      new Set([...first.body.events, ...second.body.events].map(({ id }) => id))
        .size,
    ).toBe(57);
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.form.answerActivity).toMatchObject({
      check: { actor: { id: "user-2" } },
      text: { actor: { id: "user-1" } },
    });
    for (const cursor of ["0", "-1", "bogus", "9007199254740992"]) {
      const invalid = await jsonRequest(
        fixture,
        `/runs/${formId}/activity?cursor=${cursor}`,
        "GET",
      );
      expect(invalid.status).toBe(400);
    }
  });

  it("rolls back a mutation if its activity cannot be written", async () => {
    const fixture = createFixture();
    const { formId } = await createActivityForm(fixture);
    fixture.database.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END;",
    );
    const failed = await fixture.request(`/runs/${formId}`, {
      body: JSON.stringify({
        expectedRevision: 0,
        responses: { check: "pass" },
        status: "in_progress",
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(failed.status).toBe(500);
    const detail = await jsonRequest<ActivityRunResponse>(
      fixture,
      `/runs/${formId}`,
      "GET",
    );
    expect(detail.body.form.responses).toEqual({});
    expect(detail.body.form.revision).toBe(0);
  });
});

/** A form whose answers user-2 set and user-1 then changed or cleared. */
async function answeredForm(fixture: ReturnType<typeof createFixture>) {
  const { formId } = await createActivityForm(fixture);
  await jsonRequest(
    fixture,
    `/runs/${formId}`,
    "PATCH",
    {
      expectedRevision: 0,
      responses: { check: "pass", text: "Initial note" },
      status: "in_progress",
    },
    { userId: "user-2" },
  );
  await jsonRequest(fixture, `/runs/${formId}`, "PATCH", {
    expectedRevision: 1,
    responses: { check: "fail" },
    status: "in_progress",
  });
  return formId;
}
