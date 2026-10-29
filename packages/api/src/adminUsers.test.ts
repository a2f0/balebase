import { expect, it, spyOn } from "bun:test";
import { fixture, origin, post } from "./testing/maintenanceFixture";
import { purgeRequestedUsers } from "./userDeletion";

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
