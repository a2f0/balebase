import { expect, it, spyOn } from "bun:test";
import { fixture, origin } from "../testing/maintenanceFixture";
import { runDueMaintenance } from "./jobSchedules";
import { maintenanceJobs } from "./maintenance";

type Fixture = ReturnType<typeof fixture>;

function put(cron: string, enabled = true, requestOrigin = origin) {
  return {
    method: "PUT",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ cron, enabled }),
  };
}

const queuedJobs = (f: Fixture) =>
  (
    f.database
      .query("SELECT id, job_id, cron FROM job_runs ORDER BY job_id")
      .all() as { id: string; job_id: string; cron: string }[]
  ).map((row) => row.job_id);

const changes = (f: Fixture) =>
  f.database
    .query(
      `SELECT job_id, previous_cron, previous_enabled, cron, enabled,
              actor_user_id, actor_name, actor_email
       FROM job_schedule_changes ORDER BY id`,
    )
    .all();

interface Catalog {
  jobs: {
    id: string;
    runSchedule: string;
    schedule: {
      cron: string;
      enabled: boolean;
      nextRunAt: string | null;
      updatedBy: { email: string; id: string; name: string } | null;
    } | null;
  }[];
}

async function catalog(f: Fixture) {
  return (await (await f.request("/jobs")).json()) as Catalog;
}

it("lists the seeded schedules with when each next runs", async () => {
  const f = fixture();
  const { jobs } = await catalog(f);
  const organizations = jobs.find(
    ({ id }) => id === "purgeDeletedOrganizations",
  );
  expect(organizations).toMatchObject({
    runSchedule: "Every hour at 17 minutes past the hour (UTC).",
    schedule: { cron: "17 * * * *", enabled: true, updatedBy: null },
  });
  const next = new Date(organizations?.schedule?.nextRunAt ?? "");
  expect(next.getUTCMinutes()).toBe(17);
  expect(next.getTime()).toBeGreaterThan(Date.now());
  expect(next.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  expect(jobs.find(({ id }) => id === "purgeTrashedEmails")).toMatchObject({
    runSchedule: "Not scheduled; runs only on request.",
    schedule: { enabled: false, nextRunAt: null },
  });
  expect(jobs.find(({ id }) => id === "syncFinanceConnection")).toMatchObject({
    schedule: null,
  });
});

it("seeds a schedule for every maintenance job, paused only for the request-only ones", () => {
  const f = fixture();
  // Jobs that run only when an admin starts them until one schedules them.
  const requestOnly = ["purgeTrashedEmails"];
  const seeded = new Map(
    (
      f.database
        .query("SELECT job_id, cron, enabled FROM job_schedules")
        .all() as {
        job_id: string;
        cron: string;
        enabled: number;
      }[]
    ).map((row) => [row.job_id, row]),
  );
  for (const { id } of maintenanceJobs)
    expect({ id, ...seeded.get(id) }).toEqual({
      id,
      job_id: id,
      cron: "17 * * * *",
      enabled: requestOnly.includes(id) ? 0 : 1,
    });
  expect(seeded.size).toBe(maintenanceJobs.length);
});

it("leaves a waiting run's delivery to recovery when a frequent schedule finds it again", async () => {
  const f = fixture();
  f.database.exec(`UPDATE job_schedules SET enabled = CASE
    WHEN job_id = 'purgeRequestedUsers' THEN 1 ELSE 0 END, cron = '* * * * *'`);
  const minute = Date.UTC(2026, 10, 25, 10, 17);
  await runDueMaintenance(f.bindings, minute);
  expect(f.messages).toEqual([`scheduled:purgeRequestedUsers:${minute}`]);
  // The run is still waiting a minute later: no second run and no resend.
  await runDueMaintenance(f.bindings, minute + 60_000);
  expect(f.messages).toHaveLength(1);
  expect(queuedJobs(f)).toEqual(["purgeRequestedUsers"]);
});

it("queues only the enabled jobs whose schedule matches the trigger's minute", async () => {
  const f = fixture();
  f.database.exec(`UPDATE job_schedules SET cron = '*/5 * * * *'
    WHERE job_id = 'purgeRequestedUsers'`);
  f.database.exec(`UPDATE job_schedules SET enabled = 0
    WHERE job_id = 'purgeDeletedOrganizations'`);
  await runDueMaintenance(f.bindings, Date.UTC(2026, 10, 25, 10, 16, 59));
  expect(queuedJobs(f)).toEqual([]);
  await runDueMaintenance(f.bindings, Date.UTC(2026, 10, 25, 10, 20, 5));
  expect(queuedJobs(f)).toEqual(["purgeRequestedUsers"]);
  expect(
    f.database.query("SELECT id, cron, scheduled_time FROM job_runs").get(),
  ).toEqual({
    id: `scheduled:purgeRequestedUsers:${Date.UTC(2026, 10, 25, 10, 20)}`,
    cron: "*/5 * * * *",
    scheduled_time: Date.UTC(2026, 10, 25, 10, 20),
  });
  f.database.exec("DELETE FROM job_runs");
  await runDueMaintenance(f.bindings, Date.UTC(2026, 10, 25, 11, 17));
  expect(queuedJobs(f)).toEqual([
    "maintainContracts",
    "purgeDeletedObjects",
    "purgeDiscardedFormTemplates",
    "purgeExpiredFreeFormRuns",
    "purgePendingFormIssueImages",
    "purgeStripeWebhookReceipts",
    "reconcileSubscriptionSeats",
    "refreshCheckrScreenings",
  ]);
  // A job without a saved schedule runs only on request.
  f.database.exec("DELETE FROM job_runs; DELETE FROM job_schedules");
  await runDueMaintenance(f.bindings, Date.UTC(2026, 10, 25, 12, 17));
  expect(queuedJobs(f)).toEqual([]);
});

it("queues the other due jobs when one cannot be queued", async () => {
  const f = fixture();
  f.database.exec(`CREATE TRIGGER reject_contracts BEFORE INSERT ON job_runs
    WHEN NEW.job_id = 'maintainContracts'
    BEGIN SELECT RAISE(ABORT, 'contracts unavailable'); END`);
  await expect(
    runDueMaintenance(f.bindings, Date.UTC(2026, 10, 25, 10, 17)),
  ).rejects.toThrow("Scheduled maintenance failed.");
  expect(queuedJobs(f)).toHaveLength(9);
  expect(queuedJobs(f)).not.toContain("maintainContracts");
});

it("validates and saves a schedule, recording who changed it and from what", async () => {
  const f = fixture();
  f.insertActor();
  const path = "/jobs/purgeRequestedUsers/schedule";
  for (const [cron, error] of [
    ["every hour", "Enter five cron fields in UTC"],
    ["0 0 31 2 *", "This schedule never runs."],
  ] as const) {
    const refused = await f.request(path, put(cron));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain(
      error,
    );
  }
  expect(
    (await f.request(path, put("0 3 * * *", true, "https://evil.example")))
      .status,
  ).toBe(403);
  expect(
    (await f.request("/jobs/unknown/schedule", put("0 3 * * *"))).status,
  ).toBe(404);
  expect(
    (await f.request("/jobs/syncFinanceConnection/schedule", put("0 3 * * *")))
      .status,
  ).toBe(404);
  expect(changes(f)).toEqual([]);

  const saved = await f.request(path, put("  0   3 * * * "));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    job: {
      id: "purgeRequestedUsers",
      runSchedule: "Every day at 03:00 UTC.",
      schedule: {
        cron: "0 3 * * *",
        enabled: true,
        updatedBy: {
          email: "actor@example.com",
          id: "actor",
          name: "Admin Actor",
        },
      },
    },
  });
  // Saving the same schedule again records nothing.
  expect((await f.request(path, put("0 3 * * *"))).status).toBe(200);
  const paused = await f.request(path, put("0 3 * * *", false));
  expect(await paused.json()).toMatchObject({
    job: {
      runSchedule: "Not scheduled; runs only on request.",
      schedule: { enabled: false, nextRunAt: null },
    },
  });
  const actor = {
    actor_user_id: "actor",
    actor_name: "Admin Actor",
    actor_email: "actor@example.com",
  };
  expect(changes(f)).toEqual([
    {
      job_id: "purgeRequestedUsers",
      previous_cron: "17 * * * *",
      previous_enabled: 1,
      cron: "0 3 * * *",
      enabled: 1,
      ...actor,
    },
    {
      job_id: "purgeRequestedUsers",
      previous_cron: "0 3 * * *",
      previous_enabled: 1,
      cron: "0 3 * * *",
      enabled: 0,
      ...actor,
    },
  ]);
  // The history reader lists them newest first and survives the admin's account.
  f.database.exec("DELETE FROM user WHERE id = 'actor'");
  const history = await f.request(`${path}/changes`);
  expect(await history.json()).toMatchObject({
    changes: [
      { enabled: false, previousEnabled: true, cron: "0 3 * * *" },
      { enabled: true, previousCron: "17 * * * *", cron: "0 3 * * *" },
    ],
    nextCursor: null,
  });
  expect((await f.request(`${path}/changes?cursor=bad`)).status).toBe(400);
});

it("logs only a save that changed the schedule", async () => {
  const f = fixture();
  f.insertActor();
  const path = "/jobs/purgeRequestedUsers/schedule";
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    expect((await f.request(path, put("17 * * * *"))).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
    expect((await f.request(path, put("0 3 * * *"))).status).toBe(200);
    expect(log).toHaveBeenCalledWith({
      event: "job_schedule_saved",
      jobId: "purgeRequestedUsers",
      cron: "0 3 * * *",
      enabled: true,
    });
  } finally {
    log.mockRestore();
  }
  expect(changes(f)).toHaveLength(1);
});

it("pages through schedule changes newest first, in the order they were made", async () => {
  const f = fixture();
  const insert = f.database.query(`INSERT INTO job_schedule_changes
    (job_id, changed_at, previous_cron, previous_enabled, cron, enabled,
     actor_user_id, actor_name, actor_email)
    VALUES (?, ?, '17 * * * *', 1, ?, 1,
      'actor', 'Admin Actor', 'actor@example.com')`);
  // Every change shares one timestamp, as saves within a millisecond would.
  const changedAt = "2026-11-25T10:00:00.000Z";
  for (let minute = 0; minute < 55; minute++) {
    insert.run("purgeRequestedUsers", changedAt, `${minute} * * * *`);
    if (minute === 20) insert.run("purgeTrashedEmails", changedAt, "0 0 * * *");
  }
  const path = "/jobs/purgeRequestedUsers/schedule/changes";
  type Page = { changes: { cron: string }[]; nextCursor: string | null };
  const minutes = (page: Page) =>
    page.changes.map(({ cron }) => Number(cron.split(" ")[0]));
  const first = (await (await f.request(path)).json()) as Page;
  expect(minutes(first)).toEqual(
    Array.from({ length: 50 }, (_, index) => 54 - index),
  );
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = (await (
    await f.request(
      `${path}?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    )
  ).json()) as Page;
  expect(minutes(second)).toEqual([4, 3, 2, 1, 0]);
  expect(second.nextCursor).toBeNull();
  for (const cursor of ["0", "-1", "1.5", "x"])
    expect((await f.request(`${path}?cursor=${cursor}`)).status).toBe(400);
});

it("creates a schedule for a job that had none", async () => {
  const f = fixture();
  f.insertActor();
  f.database.exec(
    "DELETE FROM job_schedules WHERE job_id = 'purgeTrashedEmails'",
  );
  expect(
    (await catalog(f)).jobs.find(({ id }) => id === "purgeTrashedEmails"),
  ).toMatchObject({
    runSchedule: "Not scheduled; runs only on request.",
    schedule: null,
  });
  const response = await f.request(
    "/jobs/purgeTrashedEmails/schedule",
    put("30 4 * * MON"),
  );
  expect(await response.json()).toMatchObject({
    job: { runSchedule: "Every Monday at 04:30 UTC." },
  });
  expect(changes(f)).toMatchObject([
    { previous_cron: null, previous_enabled: null, cron: "30 4 * * MON" },
  ]);
});

it("changes nothing for a demoted admin or an impersonated session", async () => {
  const f = fixture();
  f.insertActor();
  // The session still says admin, but the stored role no longer does.
  f.database.exec("UPDATE user SET role = 'user' WHERE id = 'actor'");
  const refused = await f.request(
    "/jobs/purgeRequestedUsers/schedule",
    put("0 3 * * *"),
  );
  expect(refused.status).toBe(403);

  const impersonated = fixture("admin", "another-admin");
  impersonated.insertActor();
  impersonated.database.exec(`UPDATE job_schedules SET updated_by = 'actor',
    updated_by_name = 'Admin Actor', updated_by_email = 'actor@example.com'
    WHERE job_id = 'purgeRequestedUsers'`);
  // The catalog still lists the schedule, but not who last changed it.
  expect(
    (await catalog(impersonated)).jobs.find(
      ({ id }) => id === "purgeRequestedUsers",
    )?.schedule,
  ).toMatchObject({ cron: "17 * * * *", updatedBy: null });
  impersonated.database.exec(`UPDATE job_schedules SET updated_by = NULL,
    updated_by_name = NULL, updated_by_email = NULL`);
  for (const response of [
    await impersonated.request(
      "/jobs/purgeRequestedUsers/schedule",
      put("0 3 * * *"),
    ),
    await impersonated.request("/jobs/purgeRequestedUsers/schedule/changes"),
  ])
    expect(response.status).toBe(403);
  for (const database of [f.database, impersonated.database]) {
    expect(
      database
        .query(
          "SELECT cron, enabled, updated_by FROM job_schedules WHERE job_id = 'purgeRequestedUsers'",
        )
        .get(),
    ).toEqual({ cron: "17 * * * *", enabled: 1, updated_by: null });
    expect(
      database
        .query("SELECT count(*) AS count FROM job_schedule_changes")
        .get(),
    ).toEqual({ count: 0 });
  }
});
