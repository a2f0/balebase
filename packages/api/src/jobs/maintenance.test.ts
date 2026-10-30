import { expect, it, spyOn } from "bun:test";
import { fixture, post } from "../testing/maintenanceFixture";
import { claimJob, recoverJobs } from "./jobRuns";
import { waitForLegacyJob } from "./legacyJobRun";
import {
  enqueueMaintenance,
  runMaintenanceJob,
  runScheduledMaintenance,
} from "./maintenance";

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
  ).toEqual({ count: 10 });
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
  expect(oldCatalog.jobs).toHaveLength(10);
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
  const diagnostics = await import("../shared/diagnostics");
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
