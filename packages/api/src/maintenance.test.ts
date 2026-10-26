import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, it, spyOn } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import { adminJobs } from "./adminJobs";
import { adminUsers } from "./adminUsers";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { runMaintenanceJob } from "./maintenance";
import { withNativeOrigin } from "./nativeRequest";
import type { Bindings } from "./types";
import { purgeRequestedUsers, userDeletion } from "./userDeletion";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const now = new Date("2026-09-28T12:00:00.000Z");
const origin = "https://app.example.com";

async function fixture(role = "admin", impersonatedBy?: string) {
  const database = new Database(":memory:");
  let beforeUserDelete: (() => void) | undefined;
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory.pathname))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    database.exec(await Bun.file(new URL(file, directory)).text());
  }
  const bindings = {
    CORS_ORIGIN: origin,
    DB: {
      async batch(statements: { execute: () => unknown }[]) {
        return database.transaction(() =>
          statements.map((statement) => statement.execute()),
        )();
      },
      prepare(sql: string) {
        let values: SQLQueryBindings[] = [];
        const statement = {
          execute() {
            const results = database.query(sql).all(...values);
            const { changes } = database
              .query("SELECT changes() AS changes")
              .get() as { changes: number };
            return { results, meta: { changes } };
          },
          bind(...params: SQLQueryBindings[]) {
            values = params;
            return statement;
          },
          async all() {
            return { results: database.query(sql).all(...values) };
          },
          async first() {
            if (sql.startsWith("DELETE FROM user WHERE")) {
              const interleave = beforeUserDelete;
              beforeUserDelete = undefined;
              interleave?.();
            }
            return database.query(sql).get(...values);
          },
          async run() {
            const result = database.query(sql).run(...values);
            return { meta: { changes: result.changes } };
          },
        };
        return statement;
      },
    },
  } as unknown as Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.req.raw = withNativeOrigin(
      context.req.raw,
      context.env.CORS_ORIGIN,
    );
    context.set("authSession", {
      user: {
        id: "actor",
        role,
        name: "Admin Actor",
        email: "actor@example.com",
      },
      session: { impersonatedBy },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/jobs", adminJobs);
  app.route("/deletion", userDeletion);
  app.route("/users", adminUsers);
  function insertUser(id: string, requestedAt?: string, userRole = "user") {
    database
      .query(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role)
      VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(
        id,
        id,
        `${id}@example.com`,
        now.toISOString(),
        now.toISOString(),
        userRole,
      );
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
    insertUser,
    beforeUserDelete(callback: () => void) {
      beforeUserDelete = callback;
    },
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

it("only purges requested, aged accounts without active memberships or protected roles", async () => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture("user");
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
          "/jobs/purgeRequestedUsers/run",
          nativePost("purgeRequestedUsers"),
        )
      ).status,
    ).toBe(403);
    const admin = await fixture();
    expect(
      (
        await admin.request(
          "/jobs/purgeRequestedUsers/run",
          nativePost("purgeRequestedUsers"),
        )
      ).status,
    ).toBe(200);
  },
);

it("records a user's own request once and permits cancellation", async () => {
  const f = await fixture("user");
  f.insertUser("actor");
  expect(
    (
      await f.request(
        "/deletion",
        post("delete my account", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect((await f.request("/deletion", post("wrong"))).status).toBe(400);
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
  const f = await fixture("user", "admin-id");
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
  const regular = await fixture("user");
  expect((await regular.request("/jobs")).status).toBe(403);
  expect(
    (
      await regular.request(
        "/jobs/purgeRequestedUsers/run",
        post("purgeRequestedUsers"),
      )
    ).status,
  ).toBe(403);
  const admin = await fixture();
  expect((await admin.request("/jobs")).status).toBe(200);
  expect(
    (
      await admin.request(
        "/jobs/purgeRequestedUsers/run",
        post("purgeRequestedUsers", "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await admin.request("/jobs/unknown/run", post("unknown"))).status,
  ).toBe(404);
  expect(
    (await admin.request("/jobs/purgeRequestedUsers/run", post("wrong")))
      .status,
  ).toBe(400);
  const response = await admin.request(
    "/jobs/purgeRequestedUsers/run",
    post("purgeRequestedUsers"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    run: {
      status: "succeeded",
      actorUserId: "actor",
      trigger: "manual",
      result: { purged: 0, blocked: 0 },
    },
  });
});

it("logs correlated start and completion records and sanitizes failed run responses", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const success = await runMaintenanceJob(
      "purgeDeletedObjects",
      async () => 3,
      { trigger: "manual", actorUserId: "actor" },
    );
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      runId: success.runId,
      status: "running",
      actorUserId: "actor",
    });
    expect(log.mock.calls[1]?.[0]).toMatchObject({
      runId: success.runId,
      status: "succeeded",
      result: 3,
    });
    const failure = await runMaintenanceJob(
      "purgeDeletedObjects",
      async () => {
        throw new Error("internal detail");
      },
      { trigger: "manual", actorUserId: "actor" },
    );
    expect(failure.status).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain("internal detail");
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      runId: failure.runId,
      status: "failed",
    });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

it("returns a failed run with its ID when a manual job fails", async () => {
  const f = await fixture();
  f.database.exec("DROP TABLE user_deletion_requests");
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await f.request(
      "/jobs/purgeRequestedUsers/run",
      post("purgeRequestedUsers"),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      run: { runId: string; status: string };
    };
    expect(body.run.status).toBe("failed");
    expect(body.run.runId).toBeString();
  } finally {
    error.mockRestore();
  }
});

it("lets root admins mark and cancel users with durable actor history", async () => {
  const f = await fixture();
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
  for (const f of [
    await fixture("user"),
    await fixture("admin", "impersonator"),
  ]) {
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
