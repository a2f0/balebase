import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import type { OfflineOperation } from "@balebase/validators/offline";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { IssueEnv } from "./issueRecords";
import { offline } from "./offline";
import type { Bindings } from "./types";

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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  expect(
    (
      await f.app.request(
        "/forms?userId=user-2&organizationId=org_user-1",
        {},
        f.env,
      )
    ).status,
  ).toBe(403);
});

it("rolls back receipts and domain writes if history fails, then retries successfully", async () => {
  const f = await fixture();
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
  const f = await fixture();
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

it("keeps device-reported audit times separate from server history time", async () => {
  const f = await fixture();
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
    templateId: "form",
    templateVersion: 1,
    responses: { check: "pass" },
  };
}

async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    await Bun.file(
      `${import.meta.dir}/../migrations/0003_create_auth.sql`,
    ).text(),
  );
  for (const id of ["user-1", "user-2"])
    db.query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, banned) VALUES (?, ?, ?, 1, '2026-10-01', '2026-10-01', 'user', 0)",
    ).run(id, id, `${id}@example.com`);
  for (const file of (
    await readdir(`${import.meta.dir}/../migrations`)
  ).sort()) {
    if (file.endsWith(".sql") && file !== "0003_create_auth.sql")
      db.exec(
        await Bun.file(`${import.meta.dir}/../migrations/${file}`).text(),
      );
  }
  db.exec(
    "INSERT INTO audit_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES ('form', 'organization', 'org_user-1', 2, 'user-1', '2026-10-01', '2026-10-01')",
  );
  for (const version of [1, 2])
    db.query(
      "INSERT INTO audit_template_versions (id, template_id, version, name, description, definition, created_by, created_at) VALUES (?, 'form', ?, ?, '', ?, 'user-1', '2026-10-01')",
    ).run(
      `version-${version}`,
      version,
      version === 1 ? "Downloaded" : "New name",
      JSON.stringify(definition),
    );
  const app = new Hono<IssueEnv>();
  app.use("*", async (context, next) => {
    context.set("organizationId", scope.organizationId);
    context.set("authSession", { user: { id: scope.userId } } as AuthSession);
    await next();
  });
  app.route("/", offline);
  const env = { DB: toD1(db) } as Bindings;
  return {
    db,
    app,
    env,
    apply: (operation: OfflineOperation, identity = scope) =>
      app.request(
        "/operations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...identity, operation }),
        },
        env,
      ),
  };
}

function toD1(db: Database) {
  return {
    batch: async (statements: { execute: () => unknown }[]) =>
      db.transaction(() =>
        statements.map((statement) => statement.execute()),
      )(),
    prepare: (sql: string) => {
      let values: SQLQueryBindings[] = [];
      const execute = () => ({
        success: true,
        meta: { changes: db.query(sql).run(...values).changes },
      });
      const statement = {
        bind: (...args: SQLQueryBindings[]) => {
          values = args;
          return statement;
        },
        first: async () => db.query(sql).get(...values),
        all: async () => ({
          results: db.query(sql).all(...values),
          success: true,
        }),
        run: async () => execute(),
        execute,
      };
      return statement;
    },
  } as unknown as D1Database;
}
