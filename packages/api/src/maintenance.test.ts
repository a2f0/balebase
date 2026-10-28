import type { Database } from "bun:sqlite";
import { afterEach, expect, it, spyOn } from "bun:test";
import { adminJobs } from "./adminJobs";
import { adminUsers } from "./adminUsers";
import { requireRole } from "./authMiddleware";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import { claimJob, recoverJobs } from "./jobRuns";
import { consumeJobs } from "./jobWorker";
import { waitForLegacyJob } from "./legacyJobRun";
import {
  enqueueMaintenance,
  runMaintenanceJob,
  runScheduledMaintenance,
} from "./maintenance";
import { withNativeOrigin } from "./nativeRequest";
import { purgeDeletedOrganizations } from "./organizationPurge";
import { testBindings } from "./testing/bindings";
import { queryHooks, toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { seedUser } from "./testing/seed";
import { testApp } from "./testing/session";
import { purgeRequestedUsers, userDeletion } from "./userDeletion";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const now = new Date("2026-09-28T12:00:00.000Z");
const origin = "https://app.example.com";

function fixture(role = "admin", impersonatedBy?: string) {
  const database = createTestDatabase();
  databases.push(database);
  const messages: string[] = [];
  const deletedKeys: string[] = [];
  const hooks = queryHooks();
  const bindings = testBindings({
    CORS_ORIGIN: origin,
    DB: toD1(database, hooks),
    FINANCE_SYNC_QUEUE: {
      async send(body: { jobId: string }) {
        messages.push(body.jobId);
      },
    } as unknown as Queue<{ jobId: string }>,
    STORAGE: {
      async delete(key: string) {
        deletedKeys.push(key);
      },
    } as unknown as R2Bucket,
  });
  const app = testApp(
    {},
    {
      email: "actor@example.com",
      name: "Admin Actor",
      role,
      session: { impersonatedBy },
      userId: "actor",
    },
  );
  app.use("*", async (context, next) => {
    context.req.raw = withNativeOrigin(
      context.req.raw,
      context.env.CORS_ORIGIN,
    );
    await next();
  });
  app.use("/jobs/*", requireRole("admin"));
  app.use("/users/*", requireRole("admin"));
  app.route("/jobs", adminJobs);
  app.route("/deletion", userDeletion);
  app.route("/users", adminUsers);
  function insertUser(id: string, requestedAt?: string, userRole = "user") {
    seedUser(database, { createdAt: now.toISOString(), id, role: userRole });
    if (requestedAt)
      database
        .query(
          "INSERT INTO user_deletion_requests (user_id, requested_at) VALUES (?, ?)",
        )
        .run(id, requestedAt);
  }
  return {
    database,
    bindings,
    messages,
    deletedKeys,
    deliver: (jobId: string) =>
      consumeJobs(
        {
          messages: [
            {
              body: { jobId },
              ack() {},
              retry() {
                throw new Error("Unexpected retry");
              },
            },
          ],
        } as unknown as MessageBatch<{ jobId: string }>,
        bindings,
      ),
    insertUser,
    beforeUserDelete: (callback: () => void) =>
      hooks.before(/^DELETE FROM user WHERE/, callback, { method: "first" }),
    beforeOrganizationPurge: (callback: () => void) =>
      hooks.before(/^DELETE FROM organization/, callback, { method: "first" }),
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext),
  };
}

function post(confirm: string, requestOrigin = origin) {
  return {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  };
}

it("purges only organizations past 30 days and honors a restore or renewed deletion before execution", async () => {
  const f = fixture();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2026-01-01', ?)`);
  for (const [id, deletedAt] of [
    ["boundary", "2026-08-29T12:00:00.000Z"],
    ["timezone", "2026-08-29T08:00:00.000-04:00"],
    ["recent", "2026-08-29T12:00:00.001Z"],
    ["active", null],
    ["invalid", "not-a-date"],
    ["restored", "2026-08-01"],
    ["renewed", "2026-08-01"],
  ] as const)
    insert.run(id, id, id, deletedAt);
  f.beforeOrganizationPurge(() => {
    f.database.exec(
      "UPDATE organization SET deletedAt = NULL WHERE id = 'restored'",
    );
    f.database.exec(
      "UPDATE organization SET deletedAt = '2026-09-28' WHERE id = 'renewed'",
    );
  });
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 2,
    skipped: 2,
    failed: 0,
  });
  expect(
    f.database.query("SELECT id FROM organization ORDER BY id").all(),
  ).toEqual(
    ["active", "invalid", "recent", "renewed", "restored"].map((id) => ({
      id,
    })),
  );
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 0,
    skipped: 0,
    failed: 0,
  });
  expect(f.deletedKeys).toEqual([]);
});

it("bounds organization purges to 25 and makes progress across repeated runs", async () => {
  const f = fixture();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2026-01-01', '2026-08-01')`);
  for (let i = 29; i >= 0; i--) {
    const id = `org-${String(i).padStart(2, "0")}`;
    insert.run(id, id, id);
  }
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 25,
    skipped: 0,
    failed: 0,
  });
  expect(
    f.database.query("SELECT id FROM organization ORDER BY id").all(),
  ).toEqual(Array.from({ length: 5 }, (_, i) => ({ id: `org-${i + 25}` })));
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 5,
    skipped: 0,
    failed: 0,
  });
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 0,
    skipped: 0,
    failed: 0,
  });
});

it("queues a confirmed organization purge, cascades records, and retains every kind of file for retryable cleanup", async () => {
  const f = fixture();
  f.insertUser("person");
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt, deletedAt)
      VALUES ('purge', 'Purge', 'purge', '2020-01-01', '2020-02-01'),
             ('keep', 'Keep', 'keep', '2020-01-01', NULL);
    INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('member', 'purge', 'person', 'owner', '2020-01-01');
    INSERT INTO objects (id, organization_id, object_key, filename, content_type, size, created_at)
      VALUES ('library', 'purge', 'purge/library', 'file.pdf', 'application/pdf', 1, '2020-01-01'),
             ('keep', 'keep', 'keep/library', 'file.pdf', 'application/pdf', 1, '2020-01-01');
    INSERT INTO objects (id, organization_id, object_key, filename, content_type, size, created_at, kind)
      VALUES ('image', 'purge', 'purge/image', 'image.png', 'image/png', 1, '2020-01-01', 'audit_issue_image');
    INSERT INTO inbound_emails (id, organization_id, envelope_from, envelope_to, raw_object_key, raw_size, received_at)
      VALUES ('email', 'purge', 'from@example.com', 'to@example.com', 'purge/raw', 1, '2020-01-01'),
             ('keep-email', 'keep', 'from@example.com', 'to@example.com', 'keep/raw', 1, '2020-01-01');
    INSERT INTO inbound_email_attachments (id, email_id, object_key, filename, content_type, size, created_at)
      VALUES ('attachment', 'email', 'purge/attachment', 'a.txt', 'text/plain', 1, '2020-01-01');
    INSERT INTO contracts (id, organization_id, title, document_object_key, document_filename,
      document_size, document_sha256, document_page_count, final_object_key, created_at, updated_at)
      VALUES ('contract', 'purge', 'Contract', 'purge/contract', 'contract.pdf', 1, 'hash', 1,
        'purge/final', '2020-01-01', '2020-01-01');
    INSERT INTO contract_templates (id, organization_id, current_version, created_at, updated_at)
      VALUES ('template', 'purge', 1, '2020-01-01', '2020-01-01');
    INSERT INTO contract_template_versions (id, template_id, version, name, definition_json,
      document_object_key, document_filename, document_size, document_sha256, document_page_count, created_at)
      VALUES ('version', 'template', 1, 'Template', '{}', 'purge/template', 'template.pdf', 1, 'hash', 1, '2020-01-01');
    INSERT INTO employee_requirements (id, organization_id, target_email, kind, title, due_date,
      document_key, created_at, updated_at)
      VALUES ('requirement', 'purge', 'person@example.com', 'form', 'Form', '2020-01-01',
        'purge/form', '2020-01-01', '2020-01-01');
    INSERT INTO employee_screening_consents (id, organization_id, requirement_id, user_id, signature_name,
      signed_at, disclosure_version, state_notices, document_key, created_at)
      VALUES ('consent', 'purge', 'requirement', 'person', 'Person', '2020-01-01', '1', '[]',
        'purge/consent', '2020-01-01');
  `);
  const catalog = (await (await f.request("/jobs")).json()) as {
    jobs: unknown[];
  };
  expect(catalog.jobs).toContainEqual(
    expect.objectContaining({
      id: "purgeDeletedOrganizations",
      name: "Purge deleted organizations",
      manual: true,
      description: expect.stringContaining("30 days"),
      runSchedule: expect.stringContaining("17 minutes past the hour"),
    }),
  );
  expect(
    (await f.request("/jobs/purgeDeletedOrganizations/runs", post("wrong")))
      .status,
  ).toBe(400);
  const response = await f.request(
    "/jobs/purgeDeletedOrganizations/runs",
    post("purgeDeletedOrganizations"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as { run: { runId: string } };
  await f.deliver(run.runId);
  await f.deliver(run.runId);
  expect(
    await (await f.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: {
      status: "succeeded",
      jobId: "purgeDeletedOrganizations",
      requestedBy: "actor",
      attempts: 1,
      output: { purged: 1 },
    },
    logs: [
      { message: "Job queued." },
      { message: "Processing attempt started." },
      { message: "Job completed." },
    ],
  });
  expect(f.database.query("SELECT id FROM organization").all()).toEqual([
    { id: "keep" },
  ]);
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'person'").all(),
  ).toEqual([{ id: "person" }]);
  expect(f.database.query("SELECT id FROM member").all()).toEqual([]);
  expect(f.database.query("SELECT id FROM inbound_emails").all()).toEqual([
    { id: "keep-email" },
  ]);
  expect(
    f.database.query("SELECT id FROM inbound_email_attachments").all(),
  ).toEqual([]);
  expect(f.database.query("SELECT id FROM contracts").all()).toEqual([]);
  expect(
    f.database.query("SELECT id FROM employee_requirements").all(),
  ).toEqual([]);
  const keys = [
    "attachment",
    "consent",
    "contract",
    "final",
    "form",
    "image",
    "library",
    "raw",
    "template",
  ].map((name) => `purge/${name}`);
  expect(
    f.database
      .query(
        "SELECT object_key, organization_id FROM deleted_object_cleanup ORDER BY object_key",
      )
      .all(),
  ).toEqual(
    keys.map((object_key) => ({ object_key, organization_id: "purge" })),
  );
  expect(f.deletedKeys).toEqual([]);
  expect(await purgeDeletedObjects(f.bindings)).toBe(0);
  const cutoffs = {
    deletedBefore: "9999-12-31",
    abandonedClaimedBefore: "9999-12-31",
  };
  const deletion = spyOn(f.bindings.STORAGE, "delete").mockRejectedValue(
    new Error("Storage unavailable"),
  );
  await expect(purgeDeletedObjects(f.bindings, cutoffs)).rejects.toThrow(
    "Storage unavailable",
  );
  deletion.mockRestore();
  expect(
    f.database
      .query("SELECT count(*) AS count FROM deleted_object_cleanup")
      .get(),
  ).toEqual({ count: 9 });
  expect(await purgeDeletedObjects(f.bindings, cutoffs)).toBe(9);
  expect(f.deletedKeys.sort()).toEqual(keys);
  expect(await purgeDeletedObjects(f.bindings, cutoffs)).toBe(0);
});

it("rolls back organization deletion and cleanup tombstones together on a cascade failure", async () => {
  const f = fixture();
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt, deletedAt)
      VALUES ('purge', 'Purge', 'purge', '2020-01-01', '2020-02-01');
    INSERT INTO inbound_emails (id, organization_id, envelope_from, envelope_to, raw_object_key, raw_size, received_at)
      VALUES ('email', 'purge', 'from@example.com', 'to@example.com', 'purge/raw', 1, '2020-01-01');
    CREATE TRIGGER reject_email_delete BEFORE DELETE ON inbound_emails
      BEGIN SELECT RAISE(ABORT, 'Failed cascade'); END;
  `);
  const run = await enqueueMaintenance(
    f.bindings,
    "purgeDeletedOrganizations",
    { trigger: "manual", actorUserId: "actor" },
  );
  await f.deliver(run.id);
  expect(await (await f.request(`/jobs/runs/${run.id}`)).json()).toMatchObject({
    run: {
      status: "failed",
      errorCode: "MAINTENANCE_FAILED",
      output: { purged: 0, skipped: 0, failed: 1 },
    },
  });
  expect(f.database.query("SELECT id FROM organization").all()).toEqual([
    { id: "purge" },
  ]);
  expect(f.database.query("SELECT id FROM inbound_emails").all()).toEqual([
    { id: "email" },
  ]);
  expect(
    f.database.query("SELECT * FROM deleted_object_cleanup").all(),
  ).toEqual([]);
  expect(f.deletedKeys).toEqual([]);
});

it("isolates failing organizations, retains partial counters, and rotates the batch", async () => {
  const f = fixture();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2020-01-01', '2020-02-01')`);
  for (let i = 0; i < 30; i++) {
    const id = `org-${String(i).padStart(2, "0")}`;
    insert.run(id, id, id);
  }
  f.database.exec(`CREATE TRIGGER reject_selected_purges BEFORE DELETE ON organization
    WHEN OLD.id < 'org-24' BEGIN SELECT RAISE(ABORT, 'Failed cascade'); END;`);
  const log = spyOn(console, "log");
  try {
    for (const output of [
      { purged: 1, skipped: 0, failed: 24 },
      { purged: 5, skipped: 0, failed: 20 },
    ]) {
      const run = await enqueueMaintenance(
        f.bindings,
        "purgeDeletedOrganizations",
        {
          trigger: "manual",
          actorUserId: "actor",
        },
      );
      await f.deliver(run.id);
      expect(
        await (await f.request(`/jobs/runs/${run.id}`)).json(),
      ).toMatchObject({
        run: { status: "failed", errorCode: "MAINTENANCE_FAILED", output },
      });
    }
    expect(
      f.database
        .query(
          "SELECT count(*) AS count FROM organization WHERE id >= 'org-24'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      f.database
        .query(
          "SELECT count(*) AS count FROM organization WHERE purgeAttemptedAt IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 24 });
    expect(log).toHaveBeenCalledWith({
      event: "organization_purged",
      organizationId: "org-24",
    });
    f.database.exec("DROP TRIGGER reject_selected_purges");
    expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
      purged: 24,
      skipped: 0,
      failed: 0,
    });
  } finally {
    log.mockRestore();
  }
});

it("only purges requested, aged accounts without active memberships or protected roles", async () => {
  const f = fixture();
  f.insertUser("eligible", "2026-08-29T12:00:00.000Z");
  f.insertUser("recent", "2026-08-29T12:00:00.001Z");
  f.insertUser("unrequested");
  f.insertUser("admin", "2026-08-01", "user, admin");
  f.insertUser("system:protected", "2026-08-01");
  f.insertUser("member", "2026-08-01");
  f.database.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('active', 'Active', 'active', '2026-01-01');
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'active', 'member', 'owner', '2026-01-01');
    INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('session', '2027-01-01', 'token', '2026-01-01', '2026-01-01', 'eligible');
    INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt) VALUES ('account', 'credential', 'eligible', 'credential', 'eligible', '2026-01-01', '2026-01-01');`);
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 1,
    blocked: 3,
  });
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM session WHERE userId = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM account WHERE userId = 'eligible'").get(),
  ).toBeNull();
  expect(
    f.database
      .query(
        "SELECT user_id FROM user_deletion_requests WHERE user_id = 'eligible'",
      )
      .get(),
  ).toBeNull();
  for (const id of [
    "recent",
    "unrequested",
    "admin",
    "system:protected",
    "member",
  ]) {
    expect(
      f.database.query("SELECT id FROM user WHERE id = ?").get(id),
    ).not.toBeNull();
  }
});

it("preserves retained references and rotates blocked users so later requests can run", async () => {
  const f = fixture();
  f.database.exec(
    "CREATE TABLE retained_test (user_id TEXT REFERENCES user(id) ON DELETE RESTRICT)",
  );
  for (let i = 0; i < 25; i++) {
    f.insertUser(`blocked-${i}`, "2026-07-01");
    f.database
      .query("INSERT INTO retained_test VALUES (?)")
      .run(`blocked-${i}`);
  }
  f.insertUser("later", "2026-08-01");
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 0,
    blocked: 25,
  });
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 1,
    blocked: 24,
  });
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'blocked-0'").get(),
  ).not.toBeNull();
});

it("preserves former members referenced by retained contracts and their audit events", async () => {
  const f = fixture();
  for (const id of ["creator", "sender", "event-actor", "unreferenced"])
    f.insertUser(id, "2026-08-01");
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt)
    VALUES ('contracts-org', 'Contracts', 'contracts', '2026-01-01');
    INSERT INTO contracts
      (id, organization_id, title, status, document_object_key,
       document_filename, document_size, document_sha256, document_page_count,
       created_by, sent_by, created_at, updated_at)
    VALUES ('retained-contract', 'contracts-org', 'Retained', 'completed',
      'contract.pdf', 'contract.pdf', 1, 'document-hash', 1,
      'creator', 'sender', '2026-01-01', '2026-01-01');
    INSERT INTO contract_events
      (id, contract_id, actor_user_id, type, created_at)
    VALUES ('retained-event', 'retained-contract', 'event-actor', 'voided', '2026-01-01');
  `);
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 1,
    blocked: 3,
  });
  expect(
    f.database.query("SELECT created_by, sent_by FROM contracts").get(),
  ).toEqual({ created_by: "creator", sent_by: "sender" });
  expect(
    f.database.query("SELECT actor_user_id FROM contract_events").get(),
  ).toEqual({ actor_user_id: "event-actor" });
  for (const id of ["creator", "sender", "event-actor"])
    expect(
      f.database.query("SELECT id FROM user WHERE id = ?").get(id),
    ).not.toBeNull();
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'unreferenced'").get(),
  ).toBeNull();
});

it.each([
  {
    name: "cancels deletion",
    sql: "DELETE FROM user_deletion_requests WHERE user_id = 'eligible'",
  },
  {
    name: "cancels and requests deletion again",
    sql: `DELETE FROM user_deletion_requests WHERE user_id = 'eligible';
      INSERT INTO user_deletion_requests (user_id, requested_at)
      VALUES ('eligible', '${now.toISOString()}')`,
  },
  {
    name: "gains admin access",
    sql: "UPDATE user SET role = 'user, admin' WHERE id = 'eligible'",
  },
  {
    name: "joins an active organization",
    sql: `INSERT INTO organization (id, name, slug, createdAt)
      VALUES ('active', 'Active', 'active', '2026-01-01');
      INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('membership', 'active', 'eligible', 'member', '2026-01-01')`,
  },
])(
  "preserves a selected account that $name before deletion",
  async ({ sql }) => {
    const f = fixture();
    f.insertUser("eligible", "2026-08-01");
    let interleaved = false;
    f.beforeUserDelete(() => {
      expect(
        f.database
          .query(
            "SELECT last_attempted_at FROM user_deletion_requests WHERE user_id = 'eligible'",
          )
          .get(),
      ).toEqual({ last_attempted_at: now.toISOString() });
      f.database.exec(sql);
      interleaved = true;
    });
    expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
      purged: 0,
      blocked: 1,
    });
    expect(interleaved).toBe(true);
    expect(
      f.database.query("SELECT id FROM user WHERE id = 'eligible'").get(),
    ).not.toBeNull();
  },
);

it.each(["capacitor://localhost", "https://localhost"])(
  "permits account deletion and admin maintenance from %s",
  async (nativeOrigin) => {
    const nativePost = (confirm: string) => ({
      ...post(confirm),
      headers: {
        "Content-Type": "application/json",
        "X-Balebase-Native-Origin": nativeOrigin,
      },
    });
    const f = fixture("user");
    f.insertUser("actor");
    expect(
      (await f.request("/deletion", nativePost("delete my account"))).status,
    ).toBe(200);
    expect(await (await f.request("/deletion")).json()).toMatchObject({
      requestedAt: expect.any(String),
    });
    expect(
      (
        await f.request("/deletion", {
          method: "DELETE",
          headers: {
            Origin: "https://evil.example",
            "X-Balebase-Native-Origin": nativeOrigin,
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/deletion", {
          method: "DELETE",
          headers: { "X-Balebase-Native-Origin": nativeOrigin },
        })
      ).status,
    ).toBe(200);
    const deletionStatus: unknown = await (await f.request("/deletion")).json();
    expect(deletionStatus).toEqual({
      requestedAt: null,
    });
    expect(
      (
        await f.request(
          "/jobs/purgeRequestedUsers/runs",
          nativePost("purgeRequestedUsers"),
        )
      ).status,
    ).toBe(403);
    const admin = fixture();
    expect(
      (
        await admin.request(
          "/jobs/purgeRequestedUsers/runs",
          nativePost("purgeRequestedUsers"),
        )
      ).status,
    ).toBe(202);
  },
);

it("records a user's own request once and permits cancellation", async () => {
  const f = fixture("user");
  f.insertUser("actor");
  expect(
    (
      await f.request(
        "/deletion",
        post("delete my account", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  const wrong = await f.request("/deletion", post("wrong"));
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toEqual({
    error: "Account deletion confirmation is required.",
  });
  expect((await f.request("/deletion", post("delete my account"))).status).toBe(
    200,
  );
  const requested = f.database
    .query("SELECT requested_at FROM user_deletion_requests")
    .get() as { requested_at: string };
  const events = () =>
    f.database
      .query(
        "SELECT action, user_id, actor_user_id, actor_name, actor_email, requested_at FROM user_deletion_events ORDER BY rowid",
      )
      .all();
  const actor = {
    user_id: "actor",
    actor_user_id: "actor",
    actor_name: "Admin Actor",
    actor_email: "actor@example.com",
  };
  expect(events()).toEqual([
    { ...actor, action: "requested", requested_at: requested.requested_at },
  ]);
  f.database
    .query("UPDATE user_deletion_requests SET requested_at = '2026-08-01'")
    .run();
  await f.request("/deletion", post("delete my account"));
  const status: unknown = await (await f.request("/deletion")).json();
  expect(status).toEqual({
    requestedAt: "2026-08-01",
  });
  expect(
    (
      await f.request("/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(200);
  expect(events()).toEqual([
    { ...actor, action: "requested", requested_at: requested.requested_at },
    { ...actor, action: "canceled", requested_at: "2026-08-01" },
  ]);
  expect(
    (
      await f.request("/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(200);
  expect(events()).toHaveLength(2);
  expect(await purgeRequestedUsers(f.bindings, now)).toEqual({
    purged: 0,
    blocked: 0,
  });
});

it("rejects deletion requests from impersonated sessions", async () => {
  const f = fixture("user", "admin-id");
  f.insertUser("actor");
  expect((await f.request("/deletion", post("delete my account"))).status).toBe(
    403,
  );
  f.database.exec(
    "INSERT INTO user_deletion_requests (user_id, requested_at) VALUES ('actor', '2026-10-01')",
  );
  expect(
    (
      await f.request("/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(403);
  expect(
    f.database
      .query("SELECT user_id, requested_at FROM user_deletion_requests")
      .get(),
  ).toEqual({ user_id: "actor", requested_at: "2026-10-01" });
  expect(f.database.query("SELECT * FROM user_deletion_events").all()).toEqual(
    [],
  );
});

it("requires root admin access, trusted origin, a known job, and explicit confirmation", async () => {
  const regular = fixture("user");
  expect((await regular.request("/jobs")).status).toBe(403);
  expect(
    (
      await regular.request(
        "/jobs/purgeRequestedUsers/runs",
        post("purgeRequestedUsers"),
      )
    ).status,
  ).toBe(403);
  const admin = fixture();
  expect((await admin.request("/jobs")).status).toBe(200);
  expect(
    (
      await admin.request(
        "/jobs/purgeRequestedUsers/runs",
        post("purgeRequestedUsers", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await admin.request("/jobs/unknown/runs", post("unknown"))).status,
  ).toBe(404);
  expect(
    (await admin.request("/jobs/purgeRequestedUsers/runs", post("wrong")))
      .status,
  ).toBe(400);
  const response = await admin.request(
    "/jobs/purgeRequestedUsers/runs",
    post("purgeRequestedUsers"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as { run: { runId: string } };
  expect(
    await (await admin.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: {
      status: "queued",
      requestedBy: "actor",
      source: "manual",
      attempts: 0,
      output: null,
    },
    logs: [{ message: "Job queued." }],
  });
  await admin.deliver(run.runId);
  expect(
    await (await admin.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: {
      status: "succeeded",
      output: { purged: 0, blocked: 0 },
      attempts: 1,
    },
    logs: [
      { message: "Job queued." },
      { message: "Processing attempt started." },
      { message: "Job completed." },
    ],
  });
  expect((await regular.request("/jobs/runs")).status).toBe(403);
  expect((await regular.request(`/jobs/runs/${run.runId}`)).status).toBe(403);
});

it("keeps a sanitized failed run and does not replay duplicate deliveries", async () => {
  const f = fixture();
  const job = await enqueueMaintenance(f.bindings, "purgeDeletedObjects", {
    trigger: "manual",
    actorUserId: "actor",
  });
  const claimed = await claimJob(f.bindings.DB, job.id);
  if (!claimed) throw new Error("Missing claim");
  await runMaintenanceJob(f.bindings.DB, claimed, async () => {
    throw new Error("secret provider response");
  });
  await f.deliver(job.id);
  const response = await f.request(`/jobs/runs/${job.id}`);
  const body = await response.text();
  expect(body).not.toContain("secret provider response");
  expect(JSON.parse(body)).toMatchObject({
    run: { status: "failed", attempts: 1, errorCode: "MAINTENANCE_FAILED" },
  });
});

it("retains execution failures after an accepted manual request", async () => {
  const f = fixture();
  f.database.exec("DROP TABLE user_deletion_requests");
  const response = await f.request(
    "/jobs/purgeRequestedUsers/runs",
    post("purgeRequestedUsers"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as { run: { runId: string } };
  await f.deliver(run.runId);
  expect(
    await (await f.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({ run: { status: "failed" } });
});

it("deduplicates active requests, recovers failed sends, and never replays interrupted maintenance", async () => {
  const f = fixture();
  if (!f.bindings.FINANCE_SYNC_QUEUE) throw new Error("Missing queue");
  const send = spyOn(f.bindings.FINANCE_SYNC_QUEUE, "send").mockRejectedValue(
    new Error("offline"),
  );
  const start = () =>
    enqueueMaintenance(f.bindings, "purgeRequestedUsers", {
      trigger: "manual",
      actorUserId: "actor",
    });
  const first = await start();
  expect((await start()).id).toBe(first.id);
  expect(
    f.database.query("SELECT count(*) AS count FROM job_logs").get(),
  ).toEqual({ count: 1 });
  send.mockRestore();
  await recoverJobs(f.bindings);
  expect(f.messages).toContain(first.id);
  expect(await claimJob(f.bindings.DB, first.id)).not.toBeNull();
  expect(await claimJob(f.bindings.DB, first.id)).toBeNull();
  f.database.exec("UPDATE job_runs SET lease_until = '2000-01-01'");
  await recoverJobs(f.bindings);
  await f.deliver(first.id);
  expect(
    f.database.query("SELECT status, attempts, error_code FROM job_runs").get(),
  ).toEqual({ status: "failed", attempts: 1, error_code: "INTERRUPTED" });
  expect((await start()).id).not.toBe(first.id);
});

it("keeps hourly scheduling idempotent and gates cleanup on retention even when messages arrive out of order", async () => {
  const f = fixture();
  const source = {
    trigger: "scheduled" as const,
    cron: "17 * * * *",
    scheduledTime: Date.now(),
  };
  await runScheduledMaintenance(f.bindings, source);
  await runScheduledMaintenance(f.bindings, source);
  expect(
    f.database.query("SELECT count(*) AS count FROM job_runs").get(),
  ).toEqual({ count: 9 });
  const rows = f.database.query("SELECT id, job_id FROM job_runs").all() as {
    id: string;
    job_id: string;
  }[];
  const retention = rows.find(
    (row) => row.job_id === "purgeExpiredFreeAuditRuns",
  );
  const cleanup = rows.find((row) => row.job_id === "purgeDeletedObjects");
  const organizations = rows.find(
    (row) => row.job_id === "purgeDeletedOrganizations",
  );
  if (!organizations) throw new Error("Missing organization purge job");
  if (!retention || !cleanup) throw new Error("Missing scheduled jobs");
  f.messages.length = 0;
  await recoverJobs(f.bindings);
  expect(f.messages).toContain(retention.id);
  expect(f.messages).toContain(organizations.id);
  expect(f.messages).not.toContain(cleanup.id);
  expect(await claimJob(f.bindings.DB, cleanup.id)).toBeNull();
  const parent = await claimJob(f.bindings.DB, retention.id);
  if (!parent) throw new Error("Missing retention claim");
  await runMaintenanceJob(f.bindings.DB, parent, async () => {
    throw new Error("retention failed");
  });
  expect(await claimJob(f.bindings.DB, cleanup.id)).not.toBeNull();
});

it("paginates filtered history and logs, rejects invalid filters, and expires only terminal runs after 30 days", async () => {
  const f = fixture();
  const created = new Date().toISOString();
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  for (let i = 0; i < 55; i++)
    f.database
      .query(`INSERT INTO job_runs (id, job_id, source, status, available_at, created_at, finished_at)
    VALUES (?, 'purgeRequestedUsers', 'manual', 'succeeded', ?, ?, ?)`)
      .run(`run-${String(i).padStart(2, "0")}`, created, created, created);
  const history = (await (
    await f.request("/jobs/runs?jobId=purgeRequestedUsers&status=succeeded")
  ).json()) as { runs: { runId: string }[]; nextCursor: string };
  expect(history.runs).toHaveLength(50);
  const older = (await (
    await f.request(
      `/jobs/runs?jobId=purgeRequestedUsers&status=succeeded&cursor=${encodeURIComponent(history.nextCursor)}`,
    )
  ).json()) as { runs: { runId: string }[]; nextCursor: string | null };
  expect(older.runs).toHaveLength(5);
  expect(older.nextCursor).toBeNull();
  const legacyCursor = btoa(
    JSON.stringify([created, history.runs.at(-1)?.runId]),
  );
  const legacyPage = await (
    await f.request(
      `/jobs/runs?jobId=purgeRequestedUsers&status=succeeded&cursor=${encodeURIComponent(legacyCursor)}`,
    )
  ).json();
  expect(legacyPage).toEqual(older);
  expect(
    new Set([...history.runs, ...older.runs].map((run) => run.runId)).size,
  ).toBe(55);
  for (const query of ["cursor=bad", "status=bad"])
    expect((await f.request(`/jobs/runs?${query}`)).status).toBe(400);
  expect((await f.request("/jobs/runs/missing")).status).toBe(404);
  expect((await f.request("/jobs/runs/run-00?before=bad")).status).toBe(400);
  for (let i = 0; i < 205; i++)
    f.database
      .query(
        "INSERT INTO job_logs (run_id, occurred_at, level, message, details_json) VALUES ('run-00', ?, 'info', 'Progress', '{}')",
      )
      .run(created);
  const logs = (await (await f.request("/jobs/runs/run-00")).json()) as {
    logs: { id: number }[];
    nextBefore: string;
  };
  expect(logs.logs).toHaveLength(200);
  const previous = (await (
    await f.request(`/jobs/runs/run-00?before=${logs.nextBefore}`)
  ).json()) as { logs: { id: number }[]; nextBefore: string | null };
  expect(previous.logs).toHaveLength(6);
  expect(previous.nextBefore).toBeNull();
  expect(
    new Set([...logs.logs, ...previous.logs].map((log) => log.id)).size,
  ).toBe(206);
  f.database
    .query("UPDATE job_runs SET finished_at = ? WHERE id = 'run-00'")
    .run(old);
  f.database
    .query(
      "INSERT INTO job_runs (id, job_id, source, available_at, created_at) VALUES ('active', 'purgeRequestedUsers', 'manual', ?, ?)",
    )
    .run(created, old);
  await recoverJobs(f.bindings);
  expect(
    f.database.query("SELECT id FROM job_runs WHERE id = 'run-00'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM job_logs WHERE run_id = 'run-00'").get(),
  ).toBeNull();
  expect(
    f.database.query("SELECT id FROM job_runs WHERE id = 'active'").get(),
  ).not.toBeNull();
  expect(
    f.database.query("SELECT count(*) AS count FROM job_runs").get(),
  ).toEqual({ count: 55 });
});

it("lets root admins mark and cancel users with durable actor history", async () => {
  const f = fixture();
  f.insertUser("target");
  const response = await f.request(
    "/users/target/deletion",
    post("target@example.com"),
  );
  expect(response.status).toBe(200);
  const { requestedAt } = (await response.json()) as { requestedAt: string };
  expect(
    f.database.query("SELECT * FROM user_deletion_requests").get(),
  ).toMatchObject({
    user_id: "target",
    requested_at: requestedAt,
    requested_by_user_id: "actor",
    requested_by_name: "Admin Actor",
    requested_by_email: "actor@example.com",
  });
  expect(
    (await f.request("/users/target/deletion", post("target@example.com")))
      .status,
  ).toBe(409);
  expect(await (await f.request("/users")).json()).toMatchObject({
    total: 1,
    users: [
      {
        id: "target",
        emailVerified: true,
        banned: false,
        deletionRequestedAt: requestedAt,
        deletionRequestedByEmail: "actor@example.com",
      },
    ],
  });
  // The existing purge respects the waiting period and eventually consumes this queue.
  expect(await purgeRequestedUsers(f.bindings, new Date(requestedAt))).toEqual({
    purged: 0,
    blocked: 0,
  });
  expect(
    (
      await f.request("/users/target/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request("/users/target/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(409);
  expect(
    f.database
      .query(
        "SELECT action, actor_user_id, actor_name, actor_email, requested_at FROM user_deletion_events ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    {
      action: "requested",
      actor_user_id: "actor",
      actor_name: "Admin Actor",
      actor_email: "actor@example.com",
      requested_at: requestedAt,
    },
    {
      action: "canceled",
      actor_user_id: "actor",
      actor_name: "Admin Actor",
      actor_email: "actor@example.com",
      requested_at: requestedAt,
    },
  ]);
  expect(
    f.database.query("SELECT * FROM user_deletion_requests").all(),
  ).toEqual([]);
  expect(
    (await f.request("/users/target/deletion", post("target@example.com")))
      .status,
  ).toBe(200);
  expect(
    await purgeRequestedUsers(f.bindings, new Date(Date.now() + 31 * 86400000)),
  ).toEqual({ purged: 1, blocked: 0 });
  expect(f.database.query("SELECT * FROM user_deletion_events").all()).toEqual(
    [],
  );
});

it("restricts user deletion management to real admins with a trusted origin and confirmation", async () => {
  for (const f of [fixture("user"), fixture("admin", "impersonator")]) {
    f.insertUser("target");
    expect((await f.request("/users")).status).toBe(403);
    expect(
      (await f.request("/users/target/deletion", post("target@example.com")))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request("/users/target/deletion", {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(403);
    expect(
      f.database.query("SELECT * FROM user_deletion_events").all(),
    ).toEqual([]);
  }
  const f = fixture();
  f.insertUser("target");
  for (const method of ["POST", "DELETE"]) {
    for (const headers of [{}, { Origin: "https://evil.example" }]) {
      expect(
        (await f.request("/users/target/deletion", { method, headers })).status,
      ).toBe(403);
    }
    expect(
      (
        await f.request("/users/missing/deletion", {
          method,
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(404);
  }
  expect(
    (await f.request("/users/target/deletion", post("wrong"))).status,
  ).toBe(400);
  expect(
    (
      await f.request("/users/target/deletion", {
        method: "POST",
        headers: { Origin: origin },
        body: "{",
      })
    ).status,
  ).toBe(400);
  for (const [id, role] of [
    ["actor", "user"],
    ["admin", "user, admin"],
    ["system:test", "user"],
  ]) {
    f.insertUser(id as string, undefined, role);
    expect(
      (await f.request(`/users/${id}/deletion`, post(`${id}@example.com`)))
        .status,
    ).toBe(403);
  }
  expect(
    f.database.query("SELECT * FROM user_deletion_requests").all(),
  ).toEqual([]);
  expect(f.database.query("SELECT * FROM user_deletion_events").all()).toEqual(
    [],
  );
});

it("paginates human users deterministically and includes legacy deletion requests", async () => {
  const f = fixture();
  f.insertUser("a", "2026-10-01");
  f.insertUser("b");
  f.insertUser("system:other");
  const first = await (await f.request("/users?limit=1&offset=0")).json();
  expect(first).toMatchObject({
    total: 2,
    users: [
      {
        id: "a",
        deletionRequestedAt: "2026-10-01",
        deletionRequestedByName: null,
        deletionRequestedByEmail: null,
      },
    ],
  });
  expect(
    await (await f.request("/users?limit=1&offset=1")).json(),
  ).toMatchObject({
    total: 2,
    users: [{ id: "b", deletionRequestedAt: null }],
  });
  expect(await (await f.request("/users?limit=1&offset=2")).json()).toEqual({
    total: 2,
    users: [],
  });
  for (const query of [
    "limit=0",
    "limit=101",
    "offset=-1",
    "offset=1.5",
    "offset=no",
  ]) {
    expect((await f.request(`/users?${query}`)).status).toBe(400);
  }
});

it("rolls back user deletion requests and cancellations when recording history fails", async () => {
  const f = fixture();
  f.insertUser("target");
  f.database.exec(
    "CREATE TRIGGER reject_user_deletion_event BEFORE INSERT ON user_deletion_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      (await f.request("/users/target/deletion", post("target@example.com")))
        .status,
    ).toBe(500);
    expect(
      f.database.query("SELECT * FROM user_deletion_requests").all(),
    ).toEqual([]);
    f.database.exec(
      "INSERT INTO user_deletion_requests (user_id, requested_at) VALUES ('target', '2026-10-01')",
    );
    expect(
      (
        await f.request("/users/target/deletion", {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(500);
    expect(
      f.database.query("SELECT requested_at FROM user_deletion_requests").get(),
    ).toEqual({ requested_at: "2026-10-01" });
  } finally {
    error.mockRestore();
  }
});

it("records only one request event when duplicate requests have the same timestamp", async () => {
  const f = fixture();
  f.insertUser("target");
  const clock = spyOn(Date.prototype, "toISOString").mockReturnValue(
    "2026-10-26T00:00:00.000Z",
  );
  try {
    const responses = await Promise.all([
      f.request("/users/target/deletion", post("target@example.com")),
      f.request("/users/target/deletion", post("target@example.com")),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(
      f.database
        .query("SELECT action, requested_at FROM user_deletion_events")
        .all(),
    ).toEqual([
      { action: "requested", requested_at: "2026-10-26T00:00:00.000Z" },
    ]);
  } finally {
    clock.mockRestore();
  }
});

it("preserves completed results for older apps and never reports queued work as completed", async () => {
  const f = fixture();
  const run = await enqueueMaintenance(f.bindings, "purgeRequestedUsers", {
    trigger: "manual",
    actorUserId: "actor",
  });
  expect(
    await waitForLegacyJob(f.bindings.DB, run.id, async () => {}),
  ).toBeNull();
  if (!f.bindings.FINANCE_SYNC_QUEUE) throw new Error("Missing queue");
  const send = spyOn(f.bindings.FINANCE_SYNC_QUEUE, "send").mockImplementation(
    async (body) => {
      await f.deliver(body.jobId);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  );
  try {
    const completed = await f.request(
      "/jobs/purgeRequestedUsers/run",
      post("purgeRequestedUsers"),
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      run: { status: "succeeded", result: { purged: 0, blocked: 0 } },
    });
    f.database.exec("DROP TABLE user_deletion_requests");
    const failed = await f.request(
      "/jobs/purgeRequestedUsers/run",
      post("purgeRequestedUsers"),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      run: { status: "failed", error: expect.any(String) },
    });
  } finally {
    send.mockRestore();
  }
  const oldCatalog = (await (await f.request("/jobs")).json()) as {
    jobs: { id: string }[];
  };
  expect(oldCatalog.jobs).toHaveLength(9);
  const catalog = (await (await f.request("/jobs?all=true")).json()) as {
    jobs: { id: string }[];
  };
  expect(catalog.jobs.map((job) => job.id)).toContain("syncFinanceConnection");
});

it("tells older clients that queued work continues without claiming completion", async () => {
  const f = fixture();
  const legacy = await import("./legacyJobRun");
  const wait = spyOn(legacy, "waitForLegacyJob").mockResolvedValue(null);
  try {
    const response = await f.request(
      "/jobs/purgeRequestedUsers/run",
      post("purgeRequestedUsers"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("continues in the background"),
    });
    expect(f.database.query("SELECT status FROM job_runs").get()).toEqual({
      status: "queued",
    });
  } finally {
    wait.mockRestore();
  }
});

it("reports caught and interrupted maintenance failures and treats cancellation neutrally", async () => {
  const f = fixture();
  const diagnostics = await import("./diagnostics");
  const report = spyOn(diagnostics, "captureApiError").mockResolvedValue(
    undefined,
  );
  try {
    const first = await enqueueMaintenance(f.bindings, "purgeRequestedUsers", {
      trigger: "manual",
      actorUserId: "actor",
    });
    const claimed = await claimJob(f.bindings.DB, first.id);
    if (!claimed) throw new Error("Missing claim");
    const failure = new Error("task failed");
    await runMaintenanceJob(f.bindings.DB, claimed, async () => {
      throw failure;
    });
    expect(report).toHaveBeenCalledWith(failure, "job-error");
    const next = await enqueueMaintenance(f.bindings, "purgeRequestedUsers", {
      trigger: "manual",
      actorUserId: "actor",
    });
    await claimJob(f.bindings.DB, next.id);
    f.database
      .query("UPDATE job_runs SET lease_until = '2000-01-01' WHERE id = ?")
      .run(next.id);
    await recoverJobs(f.bindings);
    expect(report).toHaveBeenCalledTimes(2);
    await recoverJobs(f.bindings);
    expect(report).toHaveBeenCalledTimes(2);
    f.database
      .query(
        "UPDATE job_runs SET status = 'cancelled', error_code = 'SYNC_CANCELLED' WHERE id = ?",
      )
      .run(first.id);
    const response = await f.request(`/jobs/runs/${first.id}`);
    expect(await response.json()).toMatchObject({
      run: { status: "cancelled", error: null },
    });
  } finally {
    report.mockRestore();
  }
});
