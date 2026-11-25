import { describe, expect, it } from "bun:test";
import {
  createActivityTemplate,
  createFixture,
  enableForProject,
  jsonRequest,
  type RunResponse,
} from "../testing/formFixture";
import { seedProject } from "../testing/seed";

const now = "2026-11-01T12:00:00.000Z";

describe("form projects", () => {
  it("starts a form only for a live project the template is turned on for", async () => {
    const fixture = createFixture();
    const templateId = await createActivityTemplate(fixture);
    const start = (body?: unknown) =>
      jsonRequest<RunResponse>(
        fixture,
        `/templates/${templateId}/runs`,
        "POST",
        body,
      );
    expect((await start()).status).toBe(400);
    // The project exists, but the template is not turned on for it.
    const projectId = seedProject(fixture.database, "org_user-1");
    expect((await start({ projectId })).status).toBe(404);
    // Turned on for another organization's project, which is not theirs.
    const elsewhere = enableForProject(
      fixture.database,
      templateId,
      "org_user-2",
    );
    expect((await start({ projectId: elsewhere })).status).toBe(404);

    enableForProject(fixture.database, templateId);
    const started = await start({ projectId });
    expect(started.status).toBe(201);
    expect(
      fixture.database
        .query("SELECT project_id FROM forms WHERE id = ?")
        .get(started.body.formId),
    ).toEqual({ project_id: projectId });

    // A deleted project takes no new forms but keeps the ones it has.
    fixture.database
      .query("UPDATE projects SET deleted_at = ? WHERE id = ?")
      .run(now, projectId);
    expect((await start({ projectId })).status).toBe(404);
    const kept = await jsonRequest<{ form: { project: unknown } }>(
      fixture,
      `/runs/${started.body.formId}`,
      "GET",
    );
    expect(kept.body.form.project).toEqual({
      deleted: true,
      id: projectId,
      name: "Test project",
    });
    const listed = await jsonRequest<{ forms: Array<{ project: unknown }> }>(
      fixture,
      "/runs",
      "GET",
    );
    expect(listed.body.forms.map((form) => form.project)).toEqual([
      { deleted: true, id: projectId, name: "Test project" },
    ]);
  });

  it("requires every form to name a project of its own organization", () => {
    const { database } = createFixture();
    const insert = (projectId: string | null, organizationId = "org_user-1") =>
      database
        .query(
          `INSERT INTO forms
           (id, organization_id, project_id, template_name, definition,
            responses, status, started_by, created_at, updated_at)
           VALUES (?, ?, ?, 'Template', '{}', '{}', 'in_progress', 'user-1', ?, ?)`,
        )
        .run(crypto.randomUUID(), organizationId, projectId, now, now);
    expect(() => insert(null)).toThrow("NOT NULL constraint failed");
    expect(() => insert("missing")).toThrow("FOREIGN KEY constraint failed");
    insert("project_org_user-1");
    // A project is never deleted outright under its forms, even by a
    // Worker from before soft deletion.
    expect(() =>
      database
        .query("DELETE FROM projects WHERE id = 'project_org_user-1'")
        .run(),
    ).toThrow("Projects are deleted softly");
    // Purging the organization removes its projects and their forms.
    database.query("DELETE FROM organization WHERE id = 'org_user-1'").run();
    expect(database.query("SELECT id FROM forms").all()).toEqual([]);
  });
});
