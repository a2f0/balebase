import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import type { OfflineOperation } from "@balebase/validators/offline";
import { testBindings } from "../testing/bindings";
import { queryHooks, toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedAccount, seedMember } from "../testing/seed";
import { testApp } from "../testing/session";
import { offline } from "./offline";

const databases: Database[] = [];
const scope = { organizationId: "org_user-1", userId: "user-1" };
const definition = {
  version: 1,
  sections: [
    {
      id: "section",
      title: "Inspection",
      items: [
        { id: "check", prompt: "Safe?", required: true, responseType: "check" },
      ],
    },
  ],
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it("syncs the exact downloaded version once, including answer and completion history", async () => {
  const f = fixture();
  const operation = audit();
  const results = await Promise.all([f.apply(operation), f.apply(operation)]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
  expect(
    f.db
      .query(
        "SELECT template_name, template_version, status, responses FROM audits",
      )
      .all(),
  ).toEqual([
    {
      template_name: "Downloaded",
      template_version: 1,
      status: "completed",
      responses: '{"check":"pass"}',
    },
  ]);
  const events = f.db
    .query("SELECT action FROM activity_events WHERE root_id = ? ORDER BY id")
    .all(operation.id);
  expect(events).toEqual([
    { action: "audit.started" },
    { action: "audit.answer_changed" },
    { action: "audit.completed" },
  ]);
  expect((await f.apply(operation)).status).toBe(200);
  expect(
    (await f.apply({ ...operation, responses: { check: "fail" } })).status,
  ).toBe(409);
  f.db.query("DELETE FROM audits WHERE id = ?").run(operation.id);
  expect((await f.apply(operation)).status).toBe(200);
  expect(f.db.query("SELECT id FROM audits").all()).toEqual([]);
});

it("requires the parent audit before its issue and does not duplicate issues on retry", async () => {
  const f = fixture();
  const parent = audit();
  const issue: OfflineOperation = {
    id: crypto.randomUUID(),
    type: "issue",
    title: "Loose rail",
    description: "Staircase",
    priority: "high",
    assignedTo: null,
    auditId: parent.id,
    itemId: "check",
  };
  expect((await f.apply(issue)).status).toBe(409);
  expect((await f.apply(parent)).status).toBe(201);
  expect((await f.apply(issue)).status).toBe(201);
  expect((await f.apply(issue)).status).toBe(200);
  expect(f.db.query("SELECT title, target_id FROM issues").all()).toEqual([
    { title: "Loose rail", target_id: parent.id },
  ]);
  expect(
    (await f.apply({ ...issue, id: crypto.randomUUID(), itemId: "missing" }))
      .status,
  ).toBe(409);
});

it("rejects wrong account and organization, invalid answers, and inaccessible templates without receipts", async () => {
  const f = fixture();
  expect((await f.apply(audit(), { ...scope, userId: "user-2" })).status).toBe(
    403,
  );
  expect(
    (await f.apply(audit(), { ...scope, organizationId: "org_user-2" })).status,
  ).toBe(403);
  expect((await f.apply({ ...audit(), responses: {} })).status).toBe(409);
  expect(
    (await f.apply({ ...audit(), responses: { check: "invalid" } })).status,
  ).toBe(409);
  expect((await f.apply({ ...audit(), templateId: "missing" })).status).toBe(
    409,
  );
  expect((await f.apply({ ...audit(), templateVersion: 300 })).status).toBe(
    409,
  );
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([]);
  expect(f.db.query("SELECT id FROM audits").all()).toEqual([]);
});

interface Synced {
  changed: boolean;
  cursor: string;
  forms?: { id: string; version: number }[];
  members?: { id: string; name: string }[];
  projects?: {
    description: string;
    formIds: string[];
    id: string;
    name: string;
  }[];
}

it("syncs the person's projects and their published forms by cursor", async () => {
  const f = fixture();
  const first = await f.sync();
  expect(first).toMatchObject({ changed: true, forms: [], projects: [] });
  expect(first.members?.map((person) => person.id)).toEqual(["user-1"]);
  expect(await f.sync(first.cursor)).toEqual({
    changed: false,
    cursor: first.cursor,
  });
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at)
    VALUES ('mine', 'org_user-1', 'Mine', '2026-10-01', '2026-10-01'),
           ('theirs', 'org_user-1', 'Theirs', '2026-10-01', '2026-10-01'),
           ('elsewhere', 'org_user-2', 'Elsewhere', '2026-10-01', '2026-10-01');
    INSERT INTO project_members (project_id, organization_id, user_id, added_at)
    VALUES ('mine', 'org_user-1', 'user-1', '2026-10-01'),
           ('theirs', 'org_user-1', 'user-2', '2026-10-01'),
           ('elsewhere', 'org_user-2', 'user-1', '2026-10-01');
    INSERT INTO audit_template_families
      (id, scope, organization_id, current_version, created_by, created_at, updated_at)
    VALUES ('hidden', 'global', NULL, 1, 'user-1', '2026-10-01', '2026-10-01');
    INSERT INTO audit_template_versions
      (id, template_id, version, name, description, definition, status, created_by, created_at)
    VALUES ('hidden-1', 'hidden', 1, 'Draft', '', '{}', 'draft', 'user-1', '2026-10-01');
    INSERT INTO project_audit_forms (project_id, organization_id, template_id, added_at)
    VALUES ('mine', 'org_user-1', 'form', '2026-10-01'),
           ('mine', 'org_user-1', 'hidden', '2026-10-01'),
           ('mine', 'org_user-1', 'nfpa70e_global', '2026-10-01'),
           ('theirs', 'org_user-1', 'us_residential_core_global', '2026-10-01');
  `);
  const bound = await f.sync(first.cursor);
  expect(bound.cursor).not.toBe(first.cursor);
  // Not another member's project or organization, and not a draft: the
  // organization form's current version 2 is still a draft.
  expect(bound.projects).toEqual([
    { description: "", formIds: ["nfpa70e_global"], id: "mine", name: "Mine" },
  ]);
  expect(bound.forms?.map((form) => form.id)).toEqual(["nfpa70e_global"]);

  // Publishing a new version changes the cursor and serves that version.
  f.publish("form", 3, "published");
  const published = await f.sync(bound.cursor);
  expect(published.projects?.[0]?.formIds.sort()).toEqual([
    "form",
    "nfpa70e_global",
  ]);
  expect(published.forms?.find((form) => form.id === "form")?.version).toBe(3);

  // Unpublishing removes it; the set is whole, so it is simply absent.
  f.publish("form", 4, "unpublished");
  const unpublished = await f.sync(published.cursor);
  expect(unpublished.forms?.map((form) => form.id)).toEqual(["nfpa70e_global"]);

  // Renaming the project, then removing the person, each change the set.
  f.db.exec("UPDATE projects SET name = 'Renamed' WHERE id = 'mine'");
  const renamed = await f.sync(unpublished.cursor);
  expect(renamed.projects?.map((project) => project.name)).toEqual(["Renamed"]);
  f.db.exec("DELETE FROM project_members WHERE user_id = 'user-1'");
  const removed = await f.sync(renamed.cursor);
  expect(removed).toMatchObject({ changed: true, forms: [], projects: [] });

  // Changes in another organization leave this cursor alone.
  f.db.exec("UPDATE projects SET name = 'Moved' WHERE id = 'elsewhere'");
  expect((await f.sync(removed.cursor)).changed).toBe(false);
  expect(
    (await f.request("GET", "/sync?userId=user-2&organizationId=org_user-1"))
      .status,
  ).toBe(403);
});

it("changes the cursor when global forms, membership, or names change", async () => {
  const f = fixture();
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at)
    VALUES ('mine', 'org_user-1', 'Mine', '2026-10-01', '2026-10-01');
    INSERT INTO project_members (project_id, organization_id, user_id, added_at)
    VALUES ('mine', 'org_user-1', 'user-1', '2026-10-01');
    INSERT INTO project_audit_forms (project_id, organization_id, template_id, added_at)
    VALUES ('mine', 'org_user-1', 'nfpa70e_global', '2026-10-01');
  `);
  let cursor = (await f.sync()).cursor;
  const changes = [
    // A global form's new version.
    () => f.publish("nfpa70e_global", 0, "published"),
    // Someone joins, and is renamed.
    () =>
      seedMember(f.db, {
        createdAt: "2026-10-01",
        organizationId: "org_user-1",
        userId: "user-2",
      }),
    () => f.db.exec("UPDATE user SET name = 'Renamed' WHERE id = 'user-2'"),
    // The person leaves the organization: their projects no longer count.
    () =>
      f.db.exec(
        "DELETE FROM member WHERE userId = 'user-1' AND organizationId = 'org_user-1'",
      ),
  ];
  for (const change of changes) {
    change();
    const next = await f.sync(cursor);
    expect(next.changed).toBe(true);
    cursor = next.cursor;
  }
  expect(await f.sync(cursor)).toMatchObject({ changed: false });
  // Their membership was removed directly, so the sync reads as theirs but
  // lists nothing.
  const left = await f.sync();
  expect(left.projects).toEqual([]);
  expect(left.members?.map((person) => person.name)).toEqual(["Renamed"]);
});

it("records an audit against its project, even one deleted since, and refuses any other", async () => {
  const f = fixture();
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at, deleted_at)
    VALUES ('deleted', 'org_user-1', 'Deleted', '2026-10-01', '2026-10-01', '2026-10-02'),
           ('elsewhere', 'org_user-2', 'Elsewhere', '2026-10-01', '2026-10-01', NULL);
  `);
  const onProject = audit();
  const deleted = { ...audit(), projectId: "deleted" };
  for (const operation of [onProject, deleted])
    expect((await f.apply(operation)).status).toBe(201);
  for (const projectId of ["elsewhere", "missing"])
    expect((await f.apply({ ...audit(), projectId })).status).toBe(409);
  expect(
    f.db.query("SELECT id, project_id FROM audits ORDER BY project_id").all(),
  ).toEqual([
    { id: onProject.id, project_id: "audited" },
    { id: deleted.id, project_id: "deleted" },
  ]);
  expect(f.db.query("SELECT id FROM offline_operations").all()).toHaveLength(2);
});

it("syncs work on a downloaded version after the form is unpublished or discarded", async () => {
  const f = fixture();
  f.publish("form", 3, "unpublished");
  expect((await f.apply(audit())).status).toBe(201);
  f.publish("form", 4, "discarded");
  expect((await f.apply(audit())).status).toBe(201);
  // A global form unpublished after download.
  f.db
    .query(
      "INSERT INTO audit_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES ('global-form', 'global', NULL, 1, 'user-1', '2026-10-01', '2026-10-01')",
    )
    .run();
  f.db
    .query(
      "INSERT INTO audit_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES ('global-form-1', 'global-form', 1, 'Global', '', ?, 'published', 'user-1', '2026-10-01')",
    )
    .run(JSON.stringify(definition));
  f.publish("global-form", 2, "unpublished");
  expect(
    (await f.apply({ ...audit(), templateId: "global-form" })).status,
  ).toBe(201);
  // A version that was never published was never downloaded.
  expect((await f.apply({ ...audit(), templateVersion: 2 })).status).toBe(409);
});

it("rolls back receipts and domain writes if history fails, then retries successfully", async () => {
  const f = fixture();
  const operation = audit();
  f.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON activity_events WHEN NEW.action = 'audit.completed' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  expect((await f.apply(operation)).status).toBe(500);
  expect(f.db.query("SELECT id FROM audits").all()).toEqual([]);
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([]);
  f.db.exec("DROP TRIGGER fail_history");
  expect((await f.apply(operation)).status).toBe(201);
});

it("creates standalone issues and rejects former assignees", async () => {
  const f = fixture();
  const issue: OfflineOperation = {
    type: "issue",
    id: crypto.randomUUID(),
    title: "Broken gate",
    description: "",
    priority: "medium",
    assignedTo: "user-2",
  };
  expect((await f.apply(issue)).status).toBe(409);
  expect((await f.apply({ ...issue, assignedTo: null })).status).toBe(201);
  expect(f.db.query("SELECT target_type, target_id FROM issues").all()).toEqual(
    [{ target_type: "workspace", target_id: null }],
  );
});

it("keeps no receipt when the assignee leaves before the issue is written", async () => {
  const f = fixture();
  seedMember(f.db, {
    createdAt: "2026-10-01",
    organizationId: "org_user-1",
    userId: "user-2",
  });
  f.hooks.before(
    "INSERT INTO issues",
    () => f.db.exec("DELETE FROM member WHERE userId = 'user-2'"),
    { method: "batch" },
  );
  const issue: OfflineOperation = {
    type: "issue",
    id: crypto.randomUUID(),
    title: "Broken gate",
    description: "",
    priority: "medium",
    assignedTo: "user-2",
  };
  expect(await f.apply(issue)).toMatchObject({
    body: {
      error:
        "The issue assignee is no longer a member. Your local work has been kept.",
    },
    status: 409,
  });
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([]);
  expect(f.db.query("SELECT id FROM issues").all()).toEqual([]);
  expect((await f.apply({ ...issue, assignedTo: null })).status).toBe(201);
});

it("keeps device-reported audit times separate from server history time", async () => {
  const f = fixture();
  const operation = {
    ...audit(),
    startedAt: "2026-10-01T12:00:00.000Z",
    completedAt: "2026-10-01T12:30:00.000Z",
  };
  expect((await f.apply(operation)).status).toBe(201);
  const event = f.db
    .query(
      "SELECT details, occurred_at FROM activity_events WHERE action = 'audit.offline_synced'",
    )
    .get() as { details: string; occurred_at: string };
  expect(JSON.parse(event.details)).toEqual({
    clientStartedAt: operation.startedAt,
    clientCompletedAt: operation.completedAt,
  });
  expect(event.occurred_at).not.toBe(operation.completedAt);
  expect((await f.apply(operation)).status).toBe(200);
  expect(
    f.db
      .query(
        "SELECT id FROM activity_events WHERE action = 'audit.offline_synced'",
      )
      .all(),
  ).toHaveLength(1);
});

function audit(): Extract<OfflineOperation, { type: "audit" }> {
  return {
    type: "audit",
    id: crypto.randomUUID(),
    projectId: "audited",
    templateId: "form",
    templateVersion: 1,
    responses: { check: "pass" },
  };
}

function fixture() {
  const db = createTestDatabase();
  databases.push(db);
  for (const id of ["user-1", "user-2"])
    seedAccount(db, { createdAt: "2026-10-01", id });
  // The project audits are made for; no one is a member, so syncs list none.
  db.exec(
    "INSERT INTO projects (id, organization_id, name, created_at, updated_at) VALUES ('audited', 'org_user-1', 'Audited', '2026-10-01', '2026-10-01')",
  );
  db.exec(
    "INSERT INTO audit_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES ('form', 'organization', 'org_user-1', 2, 'user-1', '2026-10-01', '2026-10-01')",
  );
  // Version 1 was published and downloaded; version 2 is a draft.
  for (const version of [1, 2])
    db.query(
      "INSERT INTO audit_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES (?, 'form', ?, ?, '', ?, ?, 'user-1', '2026-10-01')",
    ).run(
      `version-${version}`,
      version,
      version === 1 ? "Downloaded" : "New name",
      JSON.stringify(definition),
      version === 1 ? "published" : "draft",
    );
  const app = testApp({ "/": offline }, scope);
  const hooks = queryHooks();
  const request = requester(app, testBindings({ DB: toD1(db, hooks) }));
  return {
    db,
    hooks,
    request,
    apply: (operation: OfflineOperation, identity = scope) =>
      request("POST", "/operations", { ...identity, operation }),
    /** Saves the form's next version (`version`, or the one after its current) with `status`. */
    publish(templateId: string, version: number, status: string) {
      const next =
        version ||
        (
          db
            .query(
              "SELECT current_version FROM audit_template_families WHERE id = ?",
            )
            .get(templateId) as { current_version: number }
        ).current_version + 1;
      db.query(
        "INSERT INTO audit_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES (?, ?, ?, 'Form', '', ?, ?, 'user-1', '2026-10-02')",
      ).run(
        `${templateId}-${next}`,
        templateId,
        next,
        JSON.stringify(definition),
        status,
      );
      db.query(
        "UPDATE audit_template_families SET current_version = ? WHERE id = ?",
      ).run(next, templateId);
    },
    async sync(after?: string) {
      const query = new URLSearchParams({
        ...scope,
        ...(after ? { after } : {}),
      });
      const response = await request<Synced>("GET", `/sync?${query}`);
      expect(response.status).toBe(200);
      return response.body;
    },
  };
}
