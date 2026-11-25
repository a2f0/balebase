import { expect, it, spyOn } from "bun:test";
import { fixture, origin } from "../testing/maintenanceFixture";
import { seedUser } from "../testing/seed";
import {
  enqueueMaintenance,
  maintenanceDryRuns,
  maintenanceJobs,
} from "./maintenance";

type Fixture = ReturnType<typeof fixture>;

const old = "2026-01-01T00:00:00.000Z";

function dryRun(jobId: string) {
  return {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: jobId, dryRun: true }),
  };
}

/** Work every purge would find: two deleted organizations, a requested account, and old files and receipts. */
function seedPurgeableRecords(f: Fixture) {
  const organization = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, ?, ?)`);
  organization.run("gone-1", "Gone", "gone-1", old, old);
  organization.run("gone-2", "Gone", "gone-2", old, old);
  f.insertUser("leaving", old);
  f.database
    .query(`INSERT INTO deleted_object_cleanup
      (id, organization_id, object_key, deleted_at) VALUES ('file', 'gone-1', 'key', ?)`)
    .run(old);
  f.database
    .query(`INSERT INTO stripe_webhook_events
      (id, event_type, stripe_created, received_at, processed_at)
      VALUES ('evt', 'invoice.paid', 1, ?, ?)`)
    .run(old, old);
}

it("queues a dry run that reports what the job would purge and purges nothing", async () => {
  const f = fixture();
  f.insertActor();
  seedPurgeableRecords(f);
  const response = await f.request(
    "/jobs/purgeDeletedOrganizations/runs",
    dryRun("purgeDeletedOrganizations"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as {
    run: { dryRun: boolean; runId: string };
  };
  expect(run.dryRun).toBe(true);
  await f.deliver(run.runId);
  expect(
    await (await f.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: {
      dryRun: true,
      status: "succeeded",
      output: { eligible: 2, wouldPurge: 2 },
    },
    logs: [
      { message: "Job queued." },
      {
        message: "Manual dry run requested.",
        details: { requestedBy: { id: "actor" } },
      },
      { message: "Processing attempt started." },
      { message: "Job completed." },
    ],
  });
  expect(
    f.database.query("SELECT count(*) AS count FROM organization").get(),
  ).toEqual({ count: 2 });
  expect(await (await f.request("/jobs/requests")).json()).toMatchObject({
    requests: [{ dryRun: true, jobId: "purgeDeletedOrganizations" }],
  });
});

it("keeps dry runs and real runs of a job apart while either is active", async () => {
  const f = fixture();
  f.insertActor();
  seedUser(f.database, {
    email: "second@example.com",
    id: "second",
    name: "Second Admin",
    role: "admin",
  });
  const request = (actorUserId: string, dryRun: boolean) =>
    enqueueMaintenance(f.bindings, "purgeRequestedUsers", {
      trigger: "manual",
      actorUserId,
      dryRun,
    });
  const real = await request("actor", false);
  const preview = await request("actor", true);
  expect(preview?.id).not.toBe(real?.id);
  expect(preview?.dry_run).toBe(1);
  expect((await request("second", true))?.id).toBe(preview?.id);
  expect((await request("second", false))?.id).toBe(real?.id);
  expect(
    f.database
      .query(
        `SELECT run_id, dry_run, joined_active_run, actor_user_id
         FROM maintenance_requests ORDER BY requested_at, rowid`,
      )
      .all(),
  ).toEqual([
    {
      run_id: real?.id,
      dry_run: 0,
      joined_active_run: 0,
      actor_user_id: "actor",
    },
    {
      run_id: preview?.id,
      dry_run: 1,
      joined_active_run: 0,
      actor_user_id: "actor",
    },
    {
      run_id: preview?.id,
      dry_run: 1,
      joined_active_run: 1,
      actor_user_id: "second",
    },
    {
      run_id: real?.id,
      dry_run: 0,
      joined_active_run: 1,
      actor_user_id: "second",
    },
  ]);
  expect(
    f.database
      .query("SELECT message FROM job_logs WHERE run_id = ? ORDER BY id")
      .all(preview?.id ?? ""),
  ).toEqual([
    { message: "Job queued." },
    { message: "Manual dry run requested." },
    { message: "Manual request joined this active dry run." },
  ]);
});

it("gives every maintenance job a dry run that writes, sends, and deletes nothing", async () => {
  const f = fixture();
  seedPurgeableRecords(f);
  f.bindings.STRIPE_PRO_PRICE_ID = "price_pro";
  const network = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("A dry run must not call a provider."),
  );
  const email = spyOn(f.bindings.EMAIL, "send");
  try {
    const before = f.database.serialize();
    const dryRuns = maintenanceDryRuns(f.bindings);
    const outputs = Object.fromEntries(
      await Promise.all(
        maintenanceJobs.map(
          async ({ id }) => [id, await dryRuns[id](`dry-run-${id}`)] as const,
        ),
      ),
    );
    expect(
      Buffer.from(f.database.serialize()).equals(Buffer.from(before)),
    ).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(f.deletedKeys).toEqual([]);
    expect(f.messages).toEqual([]);
    expect(outputs).toEqual({
      purgeDeletedOrganizations: { eligible: 2, wouldPurge: 2 },
      purgeRequestedUsers: { eligible: 1, wouldPurge: 1, wouldBlock: 0 },
      purgeExpiredFreeFormRuns: {
        eligible: 0,
        organizations: 0,
        wouldPurge: 0,
      },
      purgeDiscardedFormTemplates: { eligible: 0, wouldPurge: 0 },
      purgeTrashedEmails: { eligible: 0, wouldPurge: 0 },
      purgeDeletedObjects: { eligible: 1, wouldPurge: 1 },
      purgePendingFormIssueImages: { eligible: 0, wouldPurge: 0 },
      purgeStripeWebhookReceipts: { eligible: 1, wouldPurge: 1 },
      reconcileSubscriptionSeats: { wouldCheck: 0, storedSeatChanges: 0 },
      maintainContracts: { wouldRemind: 0, wouldResume: 0 },
      refreshCheckrScreenings: {
        skipped: true,
        eligible: 0,
        wouldRefresh: 0,
        pendingNotifications: 0,
      },
    });
  } finally {
    network.mockRestore();
    email.mockRestore();
  }
});

it("predicts an account the purge would keep", async () => {
  const f = fixture();
  f.insertUser("admin-leaving", old, "admin");
  f.insertUser("leaving", old);
  expect(
    await maintenanceDryRuns(f.bindings).purgeRequestedUsers("run"),
  ).toEqual({ eligible: 2, wouldPurge: 1, wouldBlock: 1 });
});
