import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import { activity } from "./activity";
import { audits } from "./audits";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { createFinanceRouter } from "./finance";
import { issues } from "./issues";
import { requireCapability } from "./organizationGroups";
import type { Bindings } from "./types";

const databases: Database[] = [];
const now = "2026-10-01T12:00:00.000Z";
interface TestIssue {
  id: string;
  revision: number;
  title: string;
  status: string;
  target: { type: string; available: boolean };
  assignedTo: { id: string } | null;
}
interface Event {
  action: string;
  subject: { id: string };
  actor: { id: string; apiKey: { name: string } | null };
  details: unknown;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("workspace issues", () => {
  it("creates, assigns, edits, resolves, and reopens transaction and workspace issues with history", async () => {
    const f = await fixture();
    const created = await f.request<{ issueId: string }>("/issues", "POST", {
      title: "Check duplicate",
      target: { type: "finance_transaction", id: "txn" },
      assignedTo: "user-2",
    });
    expect(created.status).toBe(201);
    const id = created.body.issueId;
    const detail = await f.request<{ issue: TestIssue }>(`/issues/${id}`);
    expect(detail.body.issue).toMatchObject({
      title: "Check duplicate",
      revision: 0,
      assignedTo: { id: "user-2" },
      target: {
        type: "finance_transaction",
        id: "txn",
        label: "Coffee",
        available: true,
      },
    });
    const updated = await f.request<{ issue: TestIssue }>(
      `/issues/${id}`,
      "PATCH",
      {
        expectedRevision: 0,
        title: "Duplicate confirmed",
        description: "Contact bank",
        priority: "high",
        assignedTo: null,
        status: "resolved",
      },
    );
    expect(updated.body.issue).toMatchObject({
      title: "Duplicate confirmed",
      revision: 1,
      status: "resolved",
      assignedTo: null,
    });
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 0,
          status: "open",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 1,
          status: "open",
        })
      ).status,
    ).toBe(200);
    const history = await f.request<{ events: Event[] }>(
      `/issues/${id}/activity`,
    );
    expect(history.body.events.map((event) => event.action).sort()).toEqual([
      "issue.assigned",
      "issue.created",
      "issue.reopened",
      "issue.resolved",
      "issue.updated",
    ]);
    expect(
      history.body.events.every(
        (event) => event.actor.id === "user-1" && event.subject.id === id,
      ),
    ).toBe(true);
    const standalone = await f.request<{ issueId: string }>("/issues", "POST", {
      title: "Review process",
    });
    expect(standalone.status).toBe(201);
    const page = await f.request<{ issues: TestIssue[] }>(
      "/issues?type=finance_transaction&targetId=txn&q=Duplicate&status=all",
    );
    expect(page.body.issues.map((issue) => issue.id)).toEqual([id]);
  });

  it("enforces organization and Finance visibility across lists, details, mutations, and activity", async () => {
    const f = await fixture();
    const created = await f.request<{ issueId: string }>("/issues", "POST", {
      title: "Private transaction",
      target: { type: "finance_transaction", id: "txn" },
    });
    const id = created.body.issueId;
    await f.request("/issues", "POST", { title: "Shared issue" });
    await f.request("/finance/transactions/txn/annotation", "PATCH", {
      note: "Private note",
      labels: [],
      reviewed: true,
    });
    f.user = "user-2";
    const page = await f.request<{ issues: TestIssue[] }>("/issues?status=all");
    expect(page.body.issues.map((issue) => issue.title)).toEqual([
      "Shared issue",
    ]);
    for (const path of [`/issues/${id}`, `/issues/${id}/activity`])
      expect((await f.request(path)).status).toBe(404);
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 0,
          status: "resolved",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.request("/issues", "POST", {
          title: "Forbidden",
          target: { type: "finance_transaction", id: "txn" },
        })
      ).status,
    ).toBe(404);
    expect((await f.request("/finance/transactions/txn")).status).toBe(403);
    expect((await f.request("/finance/transactions/txn/activity")).status).toBe(
      403,
    );
    expect(JSON.stringify((await f.request("/activity")).body)).not.toContain(
      "Private",
    );
    f.user = "user-1";
    f.organization = "org_user-2";
    expect((await f.request(`/issues/${id}`)).status).toBe(404);
    expect(
      (
        await f.request("/issues", "POST", {
          title: "Foreign target",
          target: { type: "finance_transaction", id: "txn" },
        })
      ).status,
    ).toBe(404);
    expect(JSON.stringify((await f.request("/activity")).body)).not.toContain(
      "Private",
    );
    f.organization = "org_user-1";
    // Legacy audit routes must not bypass Finance visibility with a generic issue ID.
    f.user = "user-2";
    expect(
      (await f.request(`/audits/issues/${id}`, "PATCH", { status: "resolved" }))
        .status,
    ).toBe(404);
    expect((await f.request(`/audits/issues/${id}/images`)).status).toBe(404);
  });

  it("paginates after access and status filtering without duplicates, and rejects invalid inputs", async () => {
    const f = await fixture();
    for (let i = 0; i < 56; i++)
      await f.request("/issues", "POST", { title: `Visible ${i}` });
    for (let i = 0; i < 53; i++)
      await f.request("/issues", "POST", {
        title: `Hidden ${i}`,
        target: { type: "finance_transaction", id: "txn" },
      });
    f.user = "user-2";
    const first = await f.request<{ issues: TestIssue[]; nextCursor: string }>(
      "/issues",
    );
    expect(first.body.issues).toHaveLength(50);
    const second = await f.request<{
      issues: TestIssue[];
      nextCursor: string | null;
    }>(`/issues?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.issues).toHaveLength(6);
    expect(second.body.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.body.issues, ...second.body.issues].map((issue) => issue.id),
      ).size,
    ).toBe(56);
    for (const query of [
      "status=bad",
      "type=unknown",
      "cursor=oops",
      "targetId=",
    ])
      expect((await f.request(`/issues?${query}`)).status).toBe(400);
    for (const input of [
      { title: "" },
      { title: "x", priority: "urgent" },
      { title: "x", assignedTo: "outsider" },
      { title: "x", target: { type: "unknown", id: "txn" } },
    ])
      expect((await f.request("/issues", "POST", input)).status).toBe(400);
    const history = await f.request<{ events: Event[]; nextCursor: string }>(
      "/activity",
    );
    expect(history.body.events).toHaveLength(50);
    expect(JSON.stringify(history.body.events)).not.toContain("Hidden");
    expect(history.body.nextCursor).toBeTruthy();
  });

  it("makes unavailable sources read only and removes transaction issues and history on purge", async () => {
    const f = await fixture();
    const created = await f.request<{ issueId: string }>("/issues", "POST", {
      title: "Investigate",
      target: { type: "finance_transaction", id: "txn" },
    });
    const id = created.body.issueId;
    f.db.exec(
      "UPDATE plaid_transactions SET source_status = 'removed' WHERE id = 'txn'",
    );
    expect(
      (await f.request<{ issue: TestIssue }>(`/issues/${id}`)).body.issue.target
        .available,
    ).toBe(false);
    expect(
      (await f.request<{ issues: TestIssue[] }>("/issues")).body.issues,
    ).toHaveLength(0);
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 0,
          status: "resolved",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request("/issues", "POST", {
          title: "Gone",
          target: { type: "finance_transaction", id: "txn" },
        })
      ).status,
    ).toBe(404);
    f.db.exec("DELETE FROM plaid_transactions WHERE id = 'txn'");
    expect(f.db.query("SELECT id FROM issues WHERE id = ?").get(id)).toBeNull();
    expect(
      f.db
        .query(
          "SELECT id FROM activity_events WHERE root_type = 'finance_transaction'",
        )
        .get(),
    ).toBeNull();
  });

  it("validates audit targets and records generic edits in the audit history", async () => {
    const f = await fixture();
    const definition = JSON.stringify({
      version: 1,
      sections: [
        {
          id: "section",
          title: "Checks",
          items: [
            {
              id: "check",
              prompt: "Exits clear?",
              required: true,
              responseType: "check",
            },
          ],
        },
      ],
    });
    f.db
      .query(
        `INSERT INTO audits (id, organization_id, template_name, definition, responses, status, started_by, created_at, updated_at) VALUES ('audit', 'org_user-1', 'Inspection', ?, '{}', 'in_progress', 'user-1', ?, ?)`,
      )
      .run(definition, now, now);
    const target = { type: "audit_run", id: "audit", itemId: "check" };
    expect(
      (
        await f.request("/issues", "POST", {
          title: "Unknown item",
          target: { ...target, itemId: "unknown" },
        })
      ).status,
    ).toBe(404);
    const created = await f.request<{ issueId: string }>("/issues", "POST", {
      title: "Blocked exit",
      target,
    });
    expect(created.status).toBe(201);
    const id = created.body.issueId;
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 0,
          title: "Exit repaired",
          description: "New handle installed",
          priority: "critical",
        })
      ).status,
    ).toBe(200);
    const history = await f.request<{ events: Event[] }>(
      "/audits/runs/audit/activity",
    );
    expect(history.body.events[0]).toMatchObject({
      action: "issue.updated",
      subject: { id },
      details: {
        before: { title: "Blocked exit", description: "", priority: "medium" },
        after: {
          title: "Exit repaired",
          description: "New handle installed",
          priority: "critical",
        },
      },
    });
    const ownHistory = await f.request<{ events: Event[] }>(
      `/issues/${id}/activity`,
    );
    expect(ownHistory.body.events.map((event) => event.action)).toEqual([
      "issue.updated",
      "audit.issue_created",
    ]);
    f.db.query("UPDATE audits SET deleted_at = ? WHERE id = 'audit'").run(now);
    expect(
      (await f.request("/issues", "POST", { title: "Discarded audit", target }))
        .status,
    ).toBe(404);
    expect(
      (
        await f.request(`/issues/${id}`, "PATCH", {
          expectedRevision: 1,
          title: "No longer editable",
        })
      ).status,
    ).toBe(409);
  });

  it("returns a conflict if the source disappears after validation but before insert", async () => {
    const f = await fixture();
    f.beforeBatch = () => {
      f.beforeBatch = undefined;
      f.db.exec("DELETE FROM plaid_transactions WHERE id = 'txn'");
    };
    expect(
      (
        await f.request("/issues", "POST", {
          title: "Racing purge",
          target: { type: "finance_transaction", id: "txn" },
        })
      ).status,
    ).toBe(409);
    expect(f.db.query("SELECT id FROM issues").all()).toEqual([]);
    expect(
      f.db
        .query("SELECT id FROM activity_events WHERE subject_type = 'issue'")
        .all(),
    ).toEqual([]);
  });

  it("preserves legacy audit IDs, attachments, history, and storage cleanup through migration", async () => {
    const f = await fixture(true);
    f.db
      .query(
        `INSERT INTO audits (id, organization_id, template_name, definition, responses, status, started_by, created_at, updated_at) VALUES ('audit', 'org_user-1', 'Inspection', '{}', '{}', 'in_progress', 'user-1', ?, ?)`,
      )
      .run(now, now);
    f.db
      .query(
        `INSERT INTO audit_issues (id, organization_id, audit_id, item_id, title, created_by, created_at, updated_at) VALUES ('legacy', 'org_user-1', 'audit', 'item', 'Existing issue', 'user-1', ?, ?)`,
      )
      .run(now, now);
    f.db
      .query(
        `INSERT INTO objects (id, organization_id, object_key, filename, content_type, size, created_at, kind, deletion_pending) VALUES ('image', 'org_user-1', 'audit/photo', 'photo.png', 'image/png', 3, ?, 'audit_issue_image', 0)`,
      )
      .run(now);
    f.db
      .query(
        `INSERT INTO audit_issue_images (id, issue_id, object_id, uploaded_by, slot, created_at) VALUES ('attachment', 'legacy', 'image', 'user-1', 1, ?)`,
      )
      .run(now);
    const events = f.db.query("SELECT * FROM activity_events").all();
    await migrate(f.db, "0062_create_issues.sql");
    await migrate(f.db, "0063_record_finance_annotations.sql");
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM activity_events").all()).toEqual(events);
    expect(
      f.db
        .query("SELECT deletion_pending FROM objects WHERE id = 'image'")
        .get(),
    ).toEqual({ deletion_pending: 0 });
    const issue = await f.request<{ issue: TestIssue }>("/issues/legacy");
    expect(issue.body.issue).toMatchObject({
      id: "legacy",
      target: { type: "audit_run", id: "audit" },
    });
    expect(
      (
        await f.request<{ events: Event[] }>("/issues/legacy/activity")
      ).body.events.map((event) => event.action),
    ).toEqual(["audit.issue_created"]);
    expect(
      (
        await f.request("/issues/legacy", "PATCH", {
          expectedRevision: 0,
          status: "resolved",
        })
      ).status,
    ).toBe(200);
    f.db.exec("DELETE FROM audits WHERE id = 'audit'");
    expect(
      f.db.query("SELECT id FROM issues WHERE id = 'legacy'").get(),
    ).toBeNull();
    expect(f.db.query("SELECT id FROM audit_issue_images").get()).toBeNull();
    expect(
      f.db
        .query("SELECT deletion_pending FROM objects WHERE id = 'image'")
        .get(),
    ).toEqual({ deletion_pending: 1 });
  });
});

describe("transaction annotation activity", () => {
  it("records before/after changes and clearing, skips no-ops/categories, and attributes API keys", async () => {
    const f = await fixture();
    const path = "/finance/transactions/txn/annotation";
    expect(
      (
        await f.request(path, "PATCH", {
          note: "",
          labels: [],
          reviewed: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request<{ events: Event[] }>(
          "/finance/transactions/txn/activity",
        )
      ).body.events,
    ).toHaveLength(0);
    const after = { note: "Receipt missing", labels: ["tax"], reviewed: true };
    await f.request(path, "PATCH", after);
    await f.request(path, "PATCH", after);
    f.db
      .query(
        `INSERT INTO finance_expense_categories (id, organization_id, name, created_at, updated_at) VALUES ('category', 'org_user-1', 'Travel', ?, ?)`,
      )
      .run(now, now);
    expect(
      (
        await f.request("/finance/transactions/txn/category", "PUT", {
          categoryId: "category",
        })
      ).status,
    ).toBe(200);
    let history = await f.request<{ events: Event[] }>(
      "/finance/transactions/txn/activity",
    );
    expect(history.body.events).toHaveLength(1);
    expect(history.body.events[0]).toMatchObject({
      action: "finance.transaction_annotated",
      actor: { id: "user-1" },
      details: { before: { note: "", labels: [], reviewed: false }, after },
    });
    f.db
      .query(
        `INSERT INTO organization_api_keys (id, organization_id, name, access, token_prefix, token_hash, created_by, created_at) VALUES ('key', 'org_user-1', 'Automation', 'write', 'test', 'hash', 'user-1', ?)`,
      )
      .run(now);
    f.apiKey = true;
    await f.request(path, "PATCH", { note: "", labels: [], reviewed: false });
    history = await f.request<{ events: Event[] }>(
      "/finance/transactions/txn/activity",
    );
    expect(history.body.events).toHaveLength(2);
    expect(history.body.events[0]).toMatchObject({
      actor: { apiKey: { name: "Automation", channel: "rest" } },
      details: {
        before: after,
        after: { note: "", labels: [], reviewed: false },
      },
    });
    expect(f.db.query("SELECT * FROM activity_api_key_context").all()).toEqual(
      [],
    );
    // An exact transaction URL works independently of the paginated overview.
    f.db.exec(
      "UPDATE plaid_transactions SET transaction_date = '2018-01-01' WHERE id = 'txn'",
    );
    expect(
      (
        await f.request<{
          transaction: { id: string; transactionDate: string };
        }>("/finance/transactions/txn")
      ).body.transaction,
    ).toMatchObject({ id: "txn", transactionDate: "2018-01-01" });
    expect((await f.request("/finance/transactions/missing")).status).toBe(404);
  });

  it("rolls back annotations when activity recording fails", async () => {
    const f = await fixture();
    f.db.exec(
      `CREATE TRIGGER reject_annotation_activity BEFORE INSERT ON activity_events WHEN NEW.action = 'finance.transaction_annotated' BEGIN SELECT RAISE(ABORT, 'Activity unavailable'); END`,
    );
    expect(
      (
        await f.request("/finance/transactions/txn/annotation", "PATCH", {
          note: "Should roll back",
          labels: [],
          reviewed: false,
        })
      ).status,
    ).toBe(500);
    expect(
      f.db.query("SELECT * FROM finance_transaction_annotations").all(),
    ).toEqual([]);
  });
});

async function fixture(legacy = false) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  await migrate(db, "0003_create_auth.sql");
  for (const id of ["user-1", "user-2"])
    db.query(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, banned) VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    ).run(id, id, `${id}@example.com`, now, now);
  for (const file of (
    await readdir(`${import.meta.dir}/../migrations`)
  ).sort()) {
    if (
      file.endsWith(".sql") &&
      file !== "0003_create_auth.sql" &&
      (!legacy || file < "0062")
    )
      await migrate(db, file);
  }
  db.query(
    `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('second-member', 'org_user-1', 'user-2', 'member', ?)`,
  ).run(now);
  db.query(
    `INSERT INTO plaid_items (id, organization_id, plaid_item_id, access_token_ciphertext, access_token_iv, created_by, created_at, updated_at) VALUES ('item', 'org_user-1', 'plaid-item', '', '', 'user-1', ?, ?)`,
  ).run(now, now);
  db.query(
    `INSERT INTO plaid_accounts (id, organization_id, plaid_item_record_id, plaid_account_id, name, type, updated_at) VALUES ('account', 'org_user-1', 'item', 'plaid-account', 'Checking', 'depository', ?)`,
  ).run(now);
  db.query(
    `INSERT INTO plaid_transactions (id, organization_id, plaid_item_record_id, account_record_id, plaid_transaction_id, name, amount, transaction_date, pending, updated_at) VALUES ('txn', 'org_user-1', 'item', 'account', 'plaid-txn', 'Coffee', 25, '2026-10-01', 0, ?)`,
  ).run(now);
  const state = {
    db,
    user: "user-1",
    organization: "org_user-1",
    apiKey: false,
    beforeBatch: undefined as (() => void) | undefined,
    request,
  };
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", state.organization);
    context.set("authSession", { user: { id: state.user } } as AuthSession);
    if (state.apiKey)
      context.set("apiKey", {
        id: "key",
        organizationId: state.organization,
        access: "write",
        channel: "rest",
      });
    await next();
  });
  app.route("/issues", issues);
  app.route("/activity", activity);
  app.route("/audits", audits);
  app.use("/finance/*", requireCapability("finance"));
  app.route("/finance", createFinanceRouter());
  async function request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await app.request(path, init, {
      DB: toD1(db, () => state.beforeBatch?.()),
    } as Bindings);
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as T,
    };
  }
  return state;
}
async function migrate(db: Database, file: string) {
  db.exec(await Bun.file(`${import.meta.dir}/../migrations/${file}`).text());
}
function toD1(db: Database, beforeBatch: () => void) {
  return {
    batch: async (statements: { execute: () => unknown }[]) => {
      beforeBatch();
      return db.transaction(() =>
        statements.map((statement) => statement.execute()),
      )();
    },
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const execute = () => ({
        success: true,
        meta: { changes: db.query(query).run(...values).changes },
      });
      const statement = {
        bind: (...next: SQLQueryBindings[]) => {
          values = next;
          return statement;
        },
        all: async () => ({
          results: db.query(query).all(...values),
          success: true,
        }),
        first: async () => db.query(query).get(...values),
        run: async () => execute(),
        execute,
      };
      return statement;
    },
  } as unknown as D1Database;
}
