import { expect, it } from "bun:test";
import { enqueueMaintenance } from "../jobs/maintenance";
import { fixture, origin, post } from "../testing/maintenanceFixture";
import { seedUser } from "../testing/seed";

interface HistoryPage {
  events: Array<{
    action: string;
    actor: { email: string; id: string | null; kind: string; name: string };
    id: string;
    newRole: string | null;
    occurredAt: string;
    previousRole: string | null;
    requestedAt: string | null;
  }>;
  nextCursor: string | null;
  user: { email: string; id: string; name: string };
}

interface RequestPage {
  nextCursor: string | null;
  requests: Array<{
    actor: { email: string; id: string; name: string };
    jobId: string;
    joinedActiveRun: boolean;
    runId: string;
  }>;
}

const json = async <T>(response: Response) => {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

it("shows root admins a person's role changes and deletion requests in order", async () => {
  const f = fixture();
  f.insertActor();
  f.insertUser("target", undefined, "user,admin");
  // Through the real writers: the Users page revocation, the operator script's
  // view, and marking and canceling deletion.
  const revoked = await f.request("/users/target/admin", {
    method: "DELETE",
    headers: { Origin: origin },
  });
  expect(revoked.status).toBe(200);
  f.database
    .query(
      `INSERT INTO operator_role_changes (email, role, operator_name, operator_email)
       VALUES ('target@example.com', 'admin', 'Ops Person', 'ops@example.com')`,
    )
    .run();
  f.database.query("UPDATE user SET role = 'user' WHERE id = 'target'").run();
  expect(
    (await f.request("/users/target/deletion", post("target@example.com")))
      .status,
  ).toBe(200);
  expect(
    (
      await f.request("/users/target/deletion", {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(200);
  // Spread the events in time so their order is unambiguous.
  for (const [table, action, at] of [
    ["user_role_events", "admin_revoked", "2026-09-01T00:00:00.000Z"],
    ["user_role_events", "role_set", "2026-09-02T00:00:00.000Z"],
    ["user_deletion_events", "requested", "2026-09-03T00:00:00.000Z"],
    ["user_deletion_events", "canceled", "2026-09-04T00:00:00.000Z"],
  ] as const)
    f.database
      .query(`UPDATE ${table} SET occurred_at = ? WHERE action = ?`)
      .run(at, action);
  // Entries keep the actor as they were, after the actor's account changes.
  f.database
    .query(
      "UPDATE user SET name = 'Renamed', email = 'new@example.com' WHERE id = 'actor'",
    )
    .run();

  const page = await json<HistoryPage>(
    await f.request("/users/target/history"),
  );
  expect(page.user).toEqual({
    email: "target@example.com",
    id: "target",
    name: "target",
  });
  expect(page.nextCursor).toBeNull();
  const requestedAt = page.events[0]?.requestedAt ?? null;
  expect(typeof requestedAt).toBe("string");
  expect(
    page.events.map(({ id: _, occurredAt: __, ...event }) => event),
  ).toEqual([
    {
      action: "deletion_canceled",
      actor: {
        email: "actor@example.com",
        id: "actor",
        kind: "user",
        name: "Admin Actor",
      },
      newRole: null,
      previousRole: null,
      requestedAt,
    },
    {
      action: "deletion_requested",
      actor: {
        email: "actor@example.com",
        id: "actor",
        kind: "user",
        name: "Admin Actor",
      },
      newRole: null,
      previousRole: null,
      requestedAt,
    },
    {
      action: "role_set",
      actor: {
        email: "ops@example.com",
        id: null,
        kind: "operator",
        name: "Ops Person",
      },
      newRole: "admin",
      previousRole: "user",
      requestedAt: null,
    },
    {
      action: "admin_revoked",
      actor: {
        email: "actor@example.com",
        id: "actor",
        kind: "user",
        name: "Admin Actor",
      },
      newRole: "user",
      previousRole: "user,admin",
      requestedAt: null,
    },
  ]);
  // Another person's history is their own.
  f.insertUser("other");
  expect(
    (await json<HistoryPage>(await f.request("/users/other/history"))).events,
  ).toEqual([]);
  expect((await f.request("/users/missing/history")).status).toBe(404);
  expect((await f.request("/users/target/history?cursor=%7B")).status).toBe(
    400,
  );
});

it("pages a long platform history without repeating or skipping entries", async () => {
  const f = fixture();
  f.insertActor();
  f.insertUser("target");
  const insert = f.database.query(
    `INSERT INTO user_role_events
       (id, user_id, action, occurred_at, previous_role, new_role,
        actor_kind, actor_user_id, actor_name, actor_email)
     VALUES (?, 'target', 'admin_revoked', ?, 'user,admin', 'user', 'user',
             'actor', 'Admin Actor', 'actor@example.com')`,
  );
  // Ties on time are broken by id, so a page boundary inside a tie is safe.
  for (let index = 0; index < 60; index += 1)
    insert.run(
      `event-${String(index).padStart(2, "0")}`,
      `2026-09-${String(1 + Math.floor(index / 4)).padStart(2, "0")}T00:00:00.000Z`,
    );
  const first = await json<HistoryPage>(
    await f.request("/users/target/history"),
  );
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await json<HistoryPage>(
    await f.request(
      `/users/target/history?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    ),
  );
  expect(second.nextCursor).toBeNull();
  const ids = [...first.events, ...second.events].map(({ id }) => id);
  expect(ids).toEqual(
    Array.from(
      { length: 60 },
      (_, index) => `role:event-${String(59 - index).padStart(2, "0")}`,
    ),
  );
});

it("shows root admins every manual maintenance request after its run expires", async () => {
  const f = fixture();
  f.insertActor();
  seedUser(f.database, {
    email: "second@example.com",
    id: "second",
    name: "Second Admin",
    role: "admin",
  });
  const started = await f.request(
    "/jobs/purgeDeletedOrganizations/runs",
    post("purgeDeletedOrganizations"),
  );
  expect(started.status).toBe(202);
  const { run } = (await started.json()) as { run: { runId: string } };
  // A second admin joins the active run through the job's real writer.
  await enqueueMaintenance(f.bindings, "purgeDeletedOrganizations", {
    actorUserId: "second",
    trigger: "manual",
  });
  await f.request(
    "/jobs/purgeRequestedUsers/runs",
    post("purgeRequestedUsers"),
  );
  f.database
    .query(
      `UPDATE maintenance_requests SET requested_at = CASE
         WHEN job_id = 'purgeRequestedUsers' THEN '2026-09-03T00:00:00.000Z'
         WHEN actor_user_id = 'second' THEN '2026-09-02T00:00:00.000Z'
         ELSE '2026-09-01T00:00:00.000Z' END`,
    )
    .run();
  // Requests outlive job history and the requester's account changes.
  f.database.query("DELETE FROM job_logs").run();
  f.database.query("DELETE FROM job_runs").run();
  f.database.query("DELETE FROM user WHERE id = 'second'").run();

  const page = await json<RequestPage>(await f.request("/jobs/requests"));
  expect(page.nextCursor).toBeNull();
  expect(
    page.requests.map(({ actor, jobId, joinedActiveRun }) => [
      jobId,
      actor.name,
      joinedActiveRun,
    ]),
  ).toEqual([
    ["purgeRequestedUsers", "Admin Actor", false],
    ["purgeDeletedOrganizations", "Second Admin", true],
    ["purgeDeletedOrganizations", "Admin Actor", false],
  ]);
  expect(page.requests[1]).toMatchObject({
    actor: { email: "second@example.com", id: "second" },
    runId: run.runId,
  });
  const filtered = await json<RequestPage>(
    await f.request("/jobs/requests?jobId=purgeRequestedUsers"),
  );
  expect(filtered.requests.map(({ jobId }) => jobId)).toEqual([
    "purgeRequestedUsers",
  ]);
  expect((await f.request("/jobs/requests?cursor=%7B")).status).toBe(400);
});

it("pages maintenance requests", async () => {
  const f = fixture();
  const insert = f.database.query(
    `INSERT INTO maintenance_requests
       (id, job_id, run_id, joined_active_run, requested_at, actor_user_id,
        actor_name, actor_email)
     VALUES (?, 'purgeDeletedObjects', 'run', 0, '2026-09-01T00:00:00.000Z',
             'actor', 'Admin Actor', 'actor@example.com')`,
  );
  for (let index = 0; index < 55; index += 1)
    insert.run(`request-${String(index).padStart(2, "0")}`);
  const first = await json<RequestPage & { requests: { id: string }[] }>(
    await f.request("/jobs/requests"),
  );
  const second = await json<RequestPage & { requests: { id: string }[] }>(
    await f.request(
      `/jobs/requests?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    ),
  );
  expect(first.requests).toHaveLength(50);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.requests, ...second.requests].map(({ id }) => id)).size,
  ).toBe(55);
});

it("keeps platform history from people who are not root admins", async () => {
  for (const f of [fixture("user"), fixture("admin", "impersonator")]) {
    f.insertUser("target");
    expect((await f.request("/users/target/history")).status).toBe(403);
    expect((await f.request("/jobs/requests")).status).toBe(403);
  }
});
