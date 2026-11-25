import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { seedAccount, seedProject } from "../testing/seed";

/**
 * Removable once production has applied 0107 (CONTRIBUTING.md, Database): it
 * covers only the rows stored under the audit names before it. Foreign keys
 * stay on, as in D1, so a rebuild that cascaded would lose rows here too.
 */
it("carries audits, their issues, photos, history, and jobs over to forms", () => {
  const database = createTestDatabase({ before: "0107" });
  seedAccount(database, { id: "user-1" });
  const project = seedProject(database, "org_user-1");
  const at = "2026-11-20T10:00:00.000Z";
  const definition = JSON.stringify({
    sections: [
      {
        id: "s",
        items: [
          {
            id: "q",
            prompt: "Guarded?",
            required: true,
            responseType: "check",
          },
        ],
        title: "Site",
      },
    ],
    version: 1,
  });
  database
    .query(
      `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
       VALUES ('walk', 'organization', 'org_user-1', 1, 'user-1', ?, ?)`,
    )
    .run(at, at);
  database
    .query(
      `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
       VALUES ('walk:v1', 'walk', 1, 'Site walk', '', ?, 'published',
               'user-1', ?)`,
    )
    .run(definition, at);
  database
    .query(
      `INSERT INTO project_audit_forms
         (project_id, organization_id, template_id, added_by, added_at)
       VALUES (?, 'org_user-1', 'walk', 'user-1', ?)`,
    )
    .run(project, at);
  database
    .query(
      `INSERT INTO audits
         (id, organization_id, project_id, template_id, template_family_id,
          template_version_id, template_version, template_name, definition,
          responses, status, started_by, created_at, updated_at)
       VALUES ('run', 'org_user-1', ?, NULL, 'walk', 'walk:v1', 1,
               'Site walk', ?, '{"q":"fail"}', 'in_progress', 'user-1', ?, ?)`,
    )
    .run(project, definition, at, at);
  database
    .query(
      `INSERT INTO issues
         (id, organization_id, target_type, target_id, item_id, title,
          created_by, created_at, updated_at)
       VALUES ('issue', 'org_user-1', 'audit_run', 'run', 'q', 'Rail missing',
               'user-1', ?, ?)`,
    )
    .run(at, at);
  database
    .query(
      `INSERT INTO objects
         (id, organization_id, object_key, filename, content_type, size,
          created_at, kind, deletion_pending)
       VALUES ('photo', 'org_user-1', 'organizations/org_user-1/photo',
               'rail.png', 'image/png', 3, ?, 'audit_issue_image', 1)`,
    )
    .run(at);
  database
    .query(
      `INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, slot, created_at)
       VALUES ('image', 'issue', 'photo', 'user-1', 1, ?)`,
    )
    .run(at);
  database.exec(`
    INSERT INTO activity_events
      (organization_id, root_type, root_id, root_label, subject_type,
       subject_id, action, actor_type, actor_source, causation_type,
       causation_id, actor_name, actor_email, occurred_at, details)
    VALUES
      ('org_user-1', 'project', '${project}', 'Test project', 'audit_template',
       'walk', 'project.form_disabled', 'system', 'purgeDiscardedAuditForms',
       'job_run', 'job', 'Maintenance', '', '${at}',
       '{"reason":"form_purged","templateId":"walk"}'),
      ('org_user-1', 'organization', 'org_user-1', 'Org', 'organization',
       'org_user-1', 'organization.audit_runs_purged', 'system',
       'purgeExpiredFreeAuditRuns', 'job_run', 'job', 'Maintenance', '',
       '${at}', '{"count":1}');
    INSERT INTO job_runs (id, job_id, source, available_at, created_at)
    VALUES ('job', 'purgePendingAuditIssueImages', 'manual', '${at}', '${at}');
  `);
  const before = {
    events: count(database, "activity_events"),
    users: count(database, "user"),
  };

  applyMigrations(database, { before: "0108", from: "0107" });

  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const table of [
    "audits",
    "audit_issue_images",
    "audit_template_families",
    "audit_template_versions",
    "audit_templates",
    "project_audit_forms",
    "form_issue_images_parked",
  ])
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name = ?")
        .get(table),
    ).toBeNull();
  expect(
    database.query("SELECT id, template_family_id FROM forms").all(),
  ).toEqual([{ id: "run", template_family_id: "walk" }]);
  expect(
    database.query("SELECT template_id FROM project_form_templates").all(),
  ).toEqual([{ template_id: "walk" }]);
  expect(database.query("SELECT target_type FROM issues").all()).toEqual([
    { target_type: "form_run" },
  ]);
  expect(database.query("SELECT kind FROM objects").all()).toEqual([
    { kind: "form_issue_image" },
  ]);
  expect(
    database
      .query("SELECT id, issue_id, object_id FROM form_issue_images")
      .all(),
  ).toEqual([{ id: "image", issue_id: "issue", object_id: "photo" }]);
  expect(count(database, "activity_events")).toBe(before.events);
  expect(
    database
      .query(
        `SELECT COUNT(*) AS count FROM activity_events
         WHERE root_type LIKE 'audit%' OR subject_type LIKE 'audit%'
            OR action LIKE 'audit.%' OR action LIKE 'project.form_%'
            OR action LIKE '%audit_runs%' OR actor_source LIKE '%Audit%'
            OR json_extract(details, '$.reason') = 'form_purged'`,
      )
      .get(),
  ).toEqual({ count: 0 });
  expect(
    database
      .query(
        `SELECT action, actor_source, json_extract(details, '$.reason') AS reason
         FROM activity_events WHERE actor_type = 'system' ORDER BY id`,
      )
      .all(),
  ).toEqual([
    {
      action: "project.template_disabled",
      actor_source: "purgeDiscardedFormTemplates",
      reason: "template_purged",
    },
    {
      action: "organization.form_runs_purged",
      actor_source: "purgeExpiredFreeFormRuns",
      reason: null,
    },
  ]);
  expect(
    database
      .query(
        `SELECT DISTINCT root_type, action FROM activity_events
         WHERE root_id IN ('run', 'walk') ORDER BY action`,
      )
      .all(),
  ).toEqual([
    { action: "form.issue_created", root_type: "form_run" },
    { action: "form.started", root_type: "form_run" },
    { action: "form.template_created", root_type: "form_template" },
  ]);
  expect(database.query("SELECT job_id FROM job_runs").all()).toEqual([
    { job_id: "purgePendingFormIssueImages" },
  ]);

  // The library's actor moved with everything attributed to it.
  expect(count(database, "user")).toBe(before.users);
  expect(
    database
      .query("SELECT id, name, role FROM user WHERE id LIKE 'system:%'")
      .all(),
  ).toEqual([
    {
      id: "system:template-library",
      name: "Balebase template library",
      role: "system",
    },
  ]);
  expect(
    database
      .query(
        `SELECT COUNT(*) AS count FROM form_template_families
         WHERE created_by = 'system:template-library'`,
      )
      .get(),
  ).toEqual({ count: 2 });

  // The recreated triggers record under the new names.
  database.query("UPDATE objects SET deletion_pending = 0").run();
  expect(
    database
      .query(
        `SELECT root_type, subject_type, action FROM activity_events
         WHERE subject_id = 'image'`,
      )
      .all(),
  ).toEqual([
    {
      action: "form.image_uploaded",
      root_type: "form_run",
      subject_type: "form_issue_image",
    },
  ]);
  // Deleting the form takes its issues and history with it, and tombstones
  // the photo for storage cleanup.
  database.query("DELETE FROM forms WHERE id = 'run'").run();
  expect(count(database, "issues")).toBe(0);
  expect(count(database, "form_issue_images")).toBe(0);
  expect(database.query("SELECT deletion_pending FROM objects").all()).toEqual([
    { deletion_pending: 1 },
  ]);
  expect(
    database
      .query(
        "SELECT COUNT(*) AS count FROM activity_events WHERE root_id = 'run'",
      )
      .get(),
  ).toEqual({ count: 0 });
});

function count(database: ReturnType<typeof createTestDatabase>, table: string) {
  return (
    database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0
  );
}
