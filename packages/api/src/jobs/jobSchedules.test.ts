import { expect, it } from "bun:test";
import { fixture, origin } from "../testing/maintenanceFixture";
import { runDueMaintenance } from "./jobSchedules";

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
       FROM job_schedule_changes ORDER BY changed_at, rowid`,
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
