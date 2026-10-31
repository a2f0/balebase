import { expect, it } from "bun:test";
import { fixture, post } from "../testing/maintenanceFixture";
import { seedUser } from "../testing/seed";
import { recoverJobs } from "./jobRuns";
import { enqueueMaintenance, runScheduledMaintenance } from "./maintenance";

const requests = (f: ReturnType<typeof fixture>) =>
  f.database
    .query(
      `SELECT job_id, run_id, joined_active_run, actor_user_id, actor_name, actor_email
       FROM maintenance_requests ORDER BY requested_at, rowid`,
    )
    .all();
const counts = (f: ReturnType<typeof fixture>) =>
  f.database
    .query(
      `SELECT (SELECT count(*) FROM job_runs) AS runs,
              (SELECT count(*) FROM job_logs) AS logs,
              (SELECT count(*) FROM maintenance_requests) AS requests`,
    )
    .get();

it("attributes every manual request, including one that joins an active run", async () => {
  const f = fixture();
  f.insertActor();
  seedUser(f.database, {
    email: "second@example.com",
    id: "second",
    name: "Second Admin",
    role: "user, admin",
  });
  const response = await f.request(
    "/jobs/purgeDeletedOrganizations/runs",
    post("purgeDeletedOrganizations"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as { run: { runId: string } };
  const joined = await enqueueMaintenance(
    f.bindings,
    "purgeDeletedOrganizations",
    { trigger: "manual", actorUserId: "second" },
  );
  expect(joined?.id).toBe(run.runId);
  expect(
    f.database
      .query(
        "SELECT requested_by, requested_by_name, requested_by_email FROM job_runs",
      )
      .all(),
  ).toEqual([
    {
      requested_by: "actor",
      requested_by_name: "Admin Actor",
      requested_by_email: "actor@example.com",
    },
  ]);
  expect(
    await (await f.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: { requestedByName: "Admin Actor" },
    logs: [
      { message: "Job queued.", details: { source: "manual" } },
      {
        message: "Manual run requested.",
        details: { requestedBy: { id: "actor", name: "Admin Actor" } },
      },
      {
        message: "Manual request joined this active run.",
        details: {
          requestedBy: {
            email: "second@example.com",
            id: "second",
            name: "Second Admin",
          },
        },
      },
    ],
  });
  const recorded = [
    {
      job_id: "purgeDeletedOrganizations",
      run_id: run.runId,
      joined_active_run: 0,
      actor_user_id: "actor",
      actor_name: "Admin Actor",
      actor_email: "actor@example.com",
    },
    {
      job_id: "purgeDeletedOrganizations",
      run_id: run.runId,
      joined_active_run: 1,
      actor_user_id: "second",
      actor_name: "Second Admin",
      actor_email: "second@example.com",
    },
  ];
  expect(requests(f)).toEqual(recorded);

  // The request history outlives job history and the requester's account.
  await f.deliver(run.runId);
  f.database.exec(
    "UPDATE job_runs SET finished_at = '2000-01-01T00:00:00.000Z'",
  );
  await recoverJobs(f.bindings);
  f.database.exec("DELETE FROM user WHERE id = 'second'");
  expect(counts(f)).toEqual({ runs: 0, logs: 0, requests: 2 });
  expect(requests(f)).toEqual(recorded);
});

it("records nothing for refused requests or a requester who lost admin", async () => {
  const f = fixture();
  f.insertActor();
  const before = counts(f);
  for (const [path, confirm] of [
    ["/jobs/purgeDeletedOrganizations/runs", "wrong"],
    ["/jobs/unknown/runs", "unknown"],
  ] as const) {
    expect((await f.request(path, post(confirm))).status).toBeOneOf([400, 404]);
  }
  // The session still says admin, but the stored role no longer does.
  f.database.exec("UPDATE user SET role = 'user' WHERE id = 'actor'");
  for (const path of [
    "/jobs/purgeDeletedOrganizations/runs",
    "/jobs/purgeDeletedOrganizations/run",
  ]) {
    const refused = await f.request(path, post("purgeDeletedOrganizations"));
    expect(refused.status).toBe(403);
  }
  expect(counts(f)).toEqual(before);
  expect(f.messages).toEqual([]);

  const unqueued = fixture();
  unqueued.insertActor();
  delete unqueued.bindings.FINANCE_SYNC_QUEUE;
  expect(
    (
      await unqueued.request(
        "/jobs/purgeDeletedOrganizations/runs",
        post("purgeDeletedOrganizations"),
      )
    ).status,
  ).toBe(503);
  expect(counts(unqueued)).toEqual({ runs: 0, logs: 0, requests: 0 });
});

it("rolls back the run when its request cannot be recorded", async () => {
  const f = fixture();
  f.insertActor();
  f.database.exec(
    "CREATE TRIGGER reject_request BEFORE INSERT ON maintenance_requests BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  await expect(
    enqueueMaintenance(f.bindings, "purgeDeletedOrganizations", {
      trigger: "manual",
      actorUserId: "actor",
    }),
  ).rejects.toThrow("history unavailable");
  expect(counts(f)).toEqual({ runs: 0, logs: 0, requests: 0 });
  expect(f.messages).toEqual([]);
});

it("keeps scheduled runs attributed to the scheduler", async () => {
  const f = fixture();
  await runScheduledMaintenance(f.bindings, {
    trigger: "scheduled",
    cron: "17 * * * *",
    scheduledTime: Date.now(),
  });
  expect(
    f.database
      .query(
        `SELECT DISTINCT source, requested_by, requested_by_name, requested_by_email
         FROM job_runs`,
      )
      .all(),
  ).toEqual([
    {
      source: "scheduled",
      requested_by: null,
      requested_by_name: null,
      requested_by_email: null,
    },
  ]);
  expect(requests(f)).toEqual([]);
});
