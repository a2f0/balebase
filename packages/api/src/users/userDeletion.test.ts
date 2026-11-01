import { expect, it } from "bun:test";
import { fixture, now, origin, post } from "../testing/maintenanceFixture";
import { purgeRequestedUsers } from "./userDeletion";

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
  expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
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
  expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
    purged: 0,
    blocked: 25,
  });
  expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
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
  expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
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
    expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
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
    admin.insertActor();
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
  expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
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
