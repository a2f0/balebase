import { expect, it, spyOn } from "bun:test";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { fixture, origin, post } from "../testing/maintenanceFixture";
import { seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import { purgeRequestedUsers } from "../users/userDeletion";
import { adminUsers } from "./adminUsers";

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
  expect(
    await purgeRequestedUsers(f.bindings, "run-1", new Date(requestedAt)),
  ).toEqual({
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
    await purgeRequestedUsers(
      f.bindings,
      "run-1",
      new Date(Date.now() + 31 * 86400000),
    ),
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

it("lets root admins revoke another root admin but never themselves", async () => {
  const f = fixture();
  const revoke = (id: string, init: RequestInit = {}) =>
    f.request(`/users/${id}/admin`, {
      method: "DELETE",
      headers: { Origin: origin },
      ...init,
    });
  const roleOf = (id: string) =>
    f.database.query("SELECT role FROM user WHERE id = ?").get(id);
  f.insertUser("actor", undefined, "user, admin");
  f.insertUser("peer", undefined, "user, admin");
  f.insertUser("plain");
  expect((await revoke("actor")).status).toBe(403);
  expect(roleOf("actor")).toEqual({ role: "user, admin" });
  expect((await revoke("missing")).status).toBe(404);
  expect((await revoke("plain")).status).toBe(409);
  expect((await revoke("peer", { headers: {} })).status).toBe(403);
  expect(roleOf("peer")).toEqual({ role: "user, admin" });
  expect((await revoke("peer")).status).toBe(200);
  expect(roleOf("peer")).toEqual({ role: "user" });
  expect((await revoke("peer")).status).toBe(409);
  expect(
    f.database
      .query(
        "SELECT user_id, action, previous_role, new_role, actor_user_id, actor_name, actor_email FROM user_role_events",
      )
      .all(),
  ).toEqual([
    {
      user_id: "peer",
      action: "admin_revoked",
      previous_role: "user, admin",
      new_role: "user",
      actor_user_id: "actor",
      actor_name: "Admin Actor",
      actor_email: "actor@example.com",
    },
  ]);
  for (const f2 of [fixture("user"), fixture("admin", "impersonator")]) {
    f2.insertUser("peer", undefined, "user, admin");
    expect(
      (
        await f2.request("/users/peer/admin", {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(403);
  }
});

it("does not revoke when the actor no longer holds root admin, so two admins cannot revoke each other", async () => {
  const f = fixture();
  f.insertUser("actor", undefined, "user");
  f.insertUser("peer", undefined, "user, admin");
  const response = await f.request("/users/peer/admin", {
    method: "DELETE",
    headers: { Origin: origin },
  });
  expect(response.status).toBe(409);
  expect(
    f.database.query("SELECT role FROM user WHERE id = 'peer'").get(),
  ).toEqual({ role: "user, admin" });
  expect(f.database.query("SELECT * FROM user_role_events").all()).toEqual([]);
});

it("keeps the role when recording the revocation fails", async () => {
  const f = fixture();
  f.insertUser("actor", undefined, "user, admin");
  f.insertUser("peer", undefined, "user, admin");
  f.database.exec(
    "CREATE TRIGGER reject_user_role_event BEFORE INSERT ON user_role_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      (
        await f.request("/users/peer/admin", {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(500);
    expect(
      f.database.query("SELECT role FROM user WHERE id = 'peer'").get(),
    ).toEqual({ role: "user, admin" });
  } finally {
    error.mockRestore();
  }
});

/** The admin users router alone, for request-shape checks. */
function routerFixture() {
  const database = createTestDatabase();
  seedUser(database, { id: "admin-1", role: "admin" });
  seedUser(database, { email: "person@example.com", id: "person-1" });
  const send = requester(
    testApp({ "/": adminUsers }, { role: "admin", userId: "admin-1" }),
    testBindings({ DB: toD1(database) }),
    { headers: { Origin: "https://app.test" } },
  );
  return { database, send };
}

it("refuses a deletion request without the user's email typed in", async () => {
  const { database, send } = routerFixture();
  for (const body of ["not json", {}, { confirm: "someone@example.com" }]) {
    expect(await send("POST", "/person-1/deletion", body)).toMatchObject({
      body: {
        error: "Confirm the user's email to mark this account for deletion.",
      },
      status: 400,
    });
  }
  expect(
    database
      .query("SELECT COUNT(*) AS count FROM user_deletion_requests")
      .get(),
  ).toEqual({ count: 0 });
});

it("refuses pagination outside the contract", async () => {
  const { send } = routerFixture();
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=many"]) {
    expect(await send("GET", `/?${query}`)).toMatchObject({
      body: { error: "Invalid user pagination." },
      status: 400,
    });
  }
  expect(await send("GET", "/?limit=1")).toMatchObject({
    body: { total: 2 },
    status: 200,
  });
});
