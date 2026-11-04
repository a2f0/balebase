import { describe, expect, it } from "bun:test";
import {
  createActivityForm,
  createFixture,
  enableForProject,
  jsonRequest,
  type RunResponse,
} from "../testing/auditFixture";
import { applyMigrations } from "../testing/database";
import { seedProject } from "../testing/seed";

const now = "2026-11-01T12:00:00.000Z";

describe("audit projects", () => {
  it("starts an audit only for a live project the form is turned on for", async () => {
    const fixture = createFixture();
    const templateId = await createActivityForm(fixture);
    const start = (body?: unknown) =>
      jsonRequest<RunResponse>(
        fixture,
        `/templates/${templateId}/runs`,
        "POST",
        body,
      );
    expect((await start()).status).toBe(400);
    // The project exists, but the form is not turned on for it.
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
        .query("SELECT project_id FROM audits WHERE id = ?")
        .get(started.body.auditId),
    ).toEqual({ project_id: projectId });

    // A deleted project takes no new audits but keeps the ones it has.
    fixture.database
      .query("UPDATE projects SET deleted_at = ? WHERE id = ?")
      .run(now, projectId);
    expect((await start({ projectId })).status).toBe(404);
    const kept = await jsonRequest<{ audit: { project: unknown } }>(
      fixture,
      `/runs/${started.body.auditId}`,
      "GET",
    );
    expect(kept.body.audit.project).toEqual({
      deleted: true,
      id: projectId,
      name: "Test project",
    });
    const listed = await jsonRequest<{ audits: Array<{ project: unknown }> }>(
      fixture,
      "/runs",
      "GET",
    );
    expect(listed.body.audits.map((audit) => audit.project)).toEqual([
      { deleted: true, id: projectId, name: "Test project" },
    ]);
  });

  it("requires every audit to name a project of its own organization", () => {
    const { database } = createFixture();
    const insert = (projectId: string | null, organizationId = "org_user-1") =>
      database
        .query(
          `INSERT INTO audits
           (id, organization_id, project_id, template_name, definition,
            responses, status, started_by, created_at, updated_at)
           VALUES (?, ?, ?, 'Form', '{}', '{}', 'in_progress', 'user-1', ?, ?)`,
        )
        .run(crypto.randomUUID(), organizationId, projectId, now, now);
    expect(() => insert(null)).toThrow("NOT NULL constraint failed");
    expect(() => insert("missing")).toThrow("FOREIGN KEY constraint failed");
    insert("project_org_user-1");
    // A project is never deleted outright under its audits, even by a
    // Worker from before soft deletion.
    expect(() =>
      database
        .query("DELETE FROM projects WHERE id = 'project_org_user-1'")
        .run(),
    ).toThrow("Projects are deleted softly");
    // Purging the organization removes its projects and their audits.
    database.query("DELETE FROM organization WHERE id = 'org_user-1'").run();
    expect(database.query("SELECT id FROM audits").all()).toEqual([]);
  });

  it("drops audits without a project and keeps the rest, with their history", () => {
    const { database } = createFixture({ before: "0091" });
    seedProject(database, "org_user-1");
    const insert = database.query(
      `INSERT INTO audits
       (id, organization_id, project_id, template_name, definition, responses,
        status, started_by, created_at, updated_at)
       VALUES (?, 'org_user-1', ?, 'Form', '{}', '{}', 'in_progress', 'user-1',
               ?, ?)`,
    );
    insert.run("kept", "project_org_user-1", now, now);
    insert.run("dropped", null, now, now);
    const issue = database.query(
      `INSERT INTO issues
       (target_type, id, organization_id, target_id, item_id, title,
        created_by, created_at, updated_at)
       VALUES ('audit_run', ?, 'org_user-1', ?, 'item', 'Issue', 'user-1',
               ?, ?)`,
    );
    issue.run("kept-issue", "kept", now, now);
    issue.run("dropped-issue", "dropped", now, now);

    applyMigrations(database, { from: "0091" });

    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query("SELECT id, project_id FROM audits").all()).toEqual([
      { id: "kept", project_id: "project_org_user-1" },
    ]);
    expect(database.query("SELECT id FROM issues").all()).toEqual([
      { id: "kept-issue" },
    ]);
    expect(
      database
        .query(
          "SELECT root_id FROM activity_events WHERE root_type = 'audit_run' GROUP BY root_id",
        )
        .all(),
    ).toEqual([{ root_id: "kept" }]);
    // The rebuilt table keeps its triggers: deleting the audit takes its
    // issues and history with it.
    database.query("DELETE FROM audits WHERE id = 'kept'").run();
    expect(database.query("SELECT id FROM issues").all()).toEqual([]);
    expect(
      database
        .query("SELECT id FROM activity_events WHERE root_type = 'audit_run'")
        .all(),
    ).toEqual([]);
  });
});
