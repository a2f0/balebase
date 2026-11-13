import { describe, expect, it } from "bun:test";
import type { FinanceTransactionChanges } from "@balebase/validators/finance";
import { jobRunDetail } from "../jobs/jobHistory";
import { scheduleJobs } from "../jobs/jobScheduler";
import { consumeJobs as consumeFinanceSync } from "../jobs/jobWorker";
import { organizationSettings } from "../organizations/organizationSettings";
import { findActivity } from "../shared/activity";
import {
  createFixture,
  jsonRequest,
  testApp,
  transactionPage,
} from "../testing/financeFixture";
import { requester } from "../testing/http";
import { testApp as sessionApp } from "../testing/session";
import type { Bindings } from "../types";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
} from "./plaid";

async function queuedFixture() {
  const fixture = await createFixture();
  const messages: { jobId: string }[] = [];
  fixture.bindings.FINANCE_SYNC_QUEUE = {
    send: async (body: { jobId: string }) => {
      messages.push(body);
    },
  } as unknown as Queue<{ jobId: string }>;
  const exchange = await jsonRequest<{ connectionId: string }>(
    fixture.app,
    fixture.bindings,
    "/exchange",
    "POST",
    { publicToken: "public-sandbox-test" },
  );
  const id = exchange.body.connectionId;
  const request = <T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    jsonRequest<T>(
      fixture.app,
      fixture.bindings,
      `/connections/${id}${path}`,
      method,
      body,
    );
  const deliver = (jobId: string, plaid = fixture.requestPlaid) =>
    consumeFinanceSync(
      {
        messages: [
          {
            body: { jobId },
            ack() {},
            retry() {
              throw new Error("Unexpected delivery failure");
            },
          },
        ],
      } as unknown as MessageBatch<{ jobId: string }>,
      fixture.bindings,
      plaid,
    );
  return { ...fixture, id, request, messages, deliver };
}

describe("durable finance sync", () => {
  it("rejects disabled Finance before provider calls, cancels queued work, and resumes after re-enabling", async () => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    const queued = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    const settings = sessionApp(
      { "/api/organization-settings": organizationSettings },
      {
        organizationId: "org_user-1",
        organizationRole: "owner",
        userId: "user-1",
      },
    );
    const changeSettings = requester(settings, fixture.bindings);
    expect(
      (
        await changeSettings("PATCH", "/api/organization-settings/current", {
          paidFeaturesEnabled: false,
        })
      ).status,
    ).toBe(200);
    let providerCalls = 0;
    const provider: PlaidRequest = async () => {
      providerCalls++;
      throw new Error("Disabled paid features must not call Plaid");
    };
    const app = testApp("org_user-1", provider);
    for (const [path, method, body] of [
      ["/", "GET", undefined],
      ["/link-token", "POST", {}],
      ["/exchange", "POST", { publicToken: "public-sandbox-test" }],
      [`/connections/${fixture.id}/sync-jobs`, "POST", undefined],
    ] as const) {
      expect(
        (await jsonRequest(app, fixture.bindings, path, method, body)).status,
      ).toBe(403);
    }
    await fixture.deliver(queued.body.id, provider);
    expect(
      fixture.database
        .query("SELECT status FROM job_runs WHERE id = ?")
        .get(queued.body.id),
    ).toEqual({ status: "cancelled" });
    fixture.messages.length = 0;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(
      fixture.database
        .query("SELECT status, daily_sync FROM plaid_items WHERE id = ?")
        .get(fixture.id),
    ).toEqual({ status: "active", daily_sync: 1 });
    expect(
      (
        await changeSettings("PATCH", "/api/organization-settings/current", {
          paidFeaturesEnabled: true,
        })
      ).status,
    ).toBe(200);
    await scheduleJobs(fixture.bindings);
    const resumed = fixture.messages[0];
    if (!resumed) throw new Error("Expected resumed daily sync");
    await fixture.deliver(resumed.jobId);
    expect(
      fixture.database
        .query("SELECT status FROM job_runs WHERE id = ?")
        .get(resumed.jobId),
    ).toEqual({ status: "succeeded" });
  });

  it("cancels disabled bank outbox jobs without dispatching them", async () => {
    const fixture = await queuedFixture();
    const queued = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    fixture.database
      .query(
        "UPDATE organization SET paid_features_enabled = 0 WHERE id = 'org_user-1'",
      )
      .run();
    fixture.messages.length = 0;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toEqual([]);
    expect(
      fixture.database
        .query("SELECT status FROM job_runs WHERE id = ?")
        .get(queued.body.id),
    ).toEqual({ status: "cancelled" });
  });

  it("checks the organization again before each provider page", async () => {
    const fixture = await queuedFixture();
    const queued = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    let calls = 0;
    const provider: PlaidRequest = async <T>() => {
      calls++;
      fixture.database
        .query(
          "UPDATE organization SET paid_features_enabled = 0 WHERE id = 'org_user-1'",
        )
        .run();
      return { ...transactionPage(), has_more: true } as T;
    };
    await fixture.deliver(queued.body.id, provider);
    await fixture.deliver(queued.body.id, provider);
    expect(calls).toBe(1);
    expect(
      fixture.database
        .query("SELECT status FROM job_runs WHERE id = ?")
        .get(queued.body.id),
    ).toEqual({ status: "cancelled" });
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("accepts a manual job before any Plaid work, deduplicates clicks, and finishes without another browser request", async () => {
    const fixture = await queuedFixture();
    const first = await fixture.request<{ id: string; status: string }>(
      "/sync-jobs",
      "POST",
    );
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("queued");
    expect((await fixture.request("/sync-status")).body).toMatchObject({
      connection: { syncJob: { id: first.body.id, status: "queued" } },
    });
    const foreign = await jsonRequest(
      testApp("organization-2", fixture.requestPlaid),
      fixture.bindings,
      `/connections/${fixture.id}/sync-status`,
      "GET",
    );
    expect(foreign.status).toBe(404);
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_accounts")
        .get(),
    ).toEqual({ count: 0 });
    const second = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    expect(second.body.id).toBe(first.body.id);
    await fixture.deliver(first.body.id);
    await fixture.deliver(first.body.id);
    const detail = await fixture.request<{
      connection: {
        syncJob: { status: string; added: number };
        lastSyncedAt: string;
      };
    }>("");
    expect(detail.body.connection.syncJob).toMatchObject({
      status: "succeeded",
      added: 1,
    });
    expect(detail.body.connection.lastSyncedAt).toBeString();
    const saved = await jobRunDetail(fixture.bindings.DB, first.body.id);
    expect(saved?.run).toMatchObject({
      jobId: "syncFinanceConnection",
      status: "succeeded",
      attempts: 1,
      output: { added: 1, modified: 0, removed: 0, pages: 1, restarts: 0 },
    });
    expect(saved?.logs.map((log) => log.message)).toEqual([
      "Job queued.",
      "Processing attempt started.",
      "Job completed.",
    ]);
    expect(JSON.stringify(saved)).not.toContain("cursor-test");
    expect(JSON.stringify(saved)).not.toContain("access-sandbox");
    const status = await fixture.request("/sync-status");
    expect(status.body).toMatchObject({
      connection: {
        syncJob: { status: "succeeded", added: 1 },
        lastSyncedAt: detail.body.connection.lastSyncedAt,
      },
    });
    expect(status.body).not.toHaveProperty("accounts");
    expect(status.body).not.toHaveProperty("connection.transactions");
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database.query("SELECT requested_by FROM job_runs").get(),
    ).toMatchObject({ requested_by: "user-1" });
  });

  it("audits setting changes atomically, skips no-ops, and enforces organization boundaries and valid input", async () => {
    const fixture = await queuedFixture();
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: "true" }))
        .status,
    ).toBe(400);
    expect(
      (
        await fixture.request("/sync-settings", "PATCH", {
          dailySync: true,
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: true }))
        .body,
    ).toEqual({ dailySync: true });
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    const rows = fixture.database
      .query(
        "SELECT json_extract(details, '$.after') AS daily_sync, actor_user_id FROM activity_events WHERE action = 'finance.daily_sync_changed'",
      )
      .all();
    expect(rows).toEqual([{ daily_sync: 1, actor_user_id: "user-1" }]);
    const other = testApp("organization-2", fixture.requestPlaid);
    for (const [path, method, body] of [
      ["sync-settings", "PATCH", { dailySync: false }],
      ["sync-jobs", "POST", undefined],
    ] as const) {
      expect(
        (
          await jsonRequest(
            other,
            fixture.bindings,
            `/connections/${fixture.id}/${path}`,
            method,
            body,
          )
        ).status,
      ).toBe(404);
    }
    fixture.database.exec(`CREATE TRIGGER fail_settings_history BEFORE INSERT ON activity_events WHEN NEW.action = 'finance.daily_sync_changed'
      BEGIN SELECT RAISE(ABORT, 'history failed'); END;`);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: false }))
        .status,
    ).toBe(500);
    expect(
      fixture.database.query("SELECT daily_sync FROM plaid_items").get(),
    ).toEqual({ daily_sync: 1 });
  });

  it("recovers an unsent manual job from the durable outbox", async () => {
    const fixture = await queuedFixture();
    const producer = fixture.bindings.FINANCE_SYNC_QUEUE;
    if (!producer) throw new Error("Expected queue");
    fixture.bindings.FINANCE_SYNC_QUEUE = {
      send: async () => {
        throw new Error("Queue unavailable");
      },
    } as unknown as Queue<{ jobId: string }>;
    const accepted = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    expect(accepted.status).toBe(202);
    expect(fixture.messages).toHaveLength(0);
    fixture.bindings.FINANCE_SYNC_QUEUE = producer;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toEqual([{ jobId: accepted.body.id }]);
    await fixture.deliver(accepted.body.id);
    expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual(
      { status: "succeeded" },
    );
  });

  it("schedules only opted-in connections once per UTC day and stops future runs when disabled", async () => {
    const fixture = await queuedFixture();
    const today = Date.now();
    await scheduleJobs(fixture.bindings, today);
    expect(fixture.messages).toHaveLength(0);
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    await scheduleJobs(fixture.bindings, today);
    const job = fixture.messages[0];
    if (!job) throw new Error("Expected daily job");
    await fixture.deliver(job.jobId);
    await scheduleJobs(fixture.bindings, today);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 1 });
    await scheduleJobs(fixture.bindings, today + 86_400_000);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 2 });
    expect(
      fixture.database
        .query("SELECT source, requested_by FROM job_runs LIMIT 1")
        .get(),
    ).toEqual({ source: "daily", requested_by: null });
    // Let the accepted run finish; disabling changes future scheduling only.
    fixture.database.run(
      "UPDATE job_runs SET available_at = '2000-01-01' WHERE status = 'queued'",
    );
    const next = fixture.messages.find(({ jobId }) => jobId !== job.jobId);
    if (!next) throw new Error("Expected next day's job");
    await fixture.deliver(next.jobId);
    await fixture.request("/sync-settings", "PATCH", { dailySync: false });
    await scheduleJobs(fixture.bindings, today + 2 * 86_400_000);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 2 });
  });

  it("leases one consumer at a time and rejects disconnects while a job is active", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const plaid: PlaidRequest = async <T>() => {
      calls++;
      entered.resolve();
      await finish.promise;
      return transactionPage() as T;
    };
    const running = fixture.deliver(job.id, plaid);
    await entered.promise;
    try {
      await fixture.deliver(job.id, plaid);
      expect(calls).toBe(1);
      expect((await fixture.request("", "DELETE")).status).toBe(409);
      expect(
        (await fixture.request<{ id: string }>("/sync-jobs", "POST")).body.id,
      ).toBe(job.id);
    } finally {
      finish.resolve();
      await running;
    }
    expect((await fixture.request("", "DELETE")).status).toBe(204);
    expect((await fixture.request("/sync-jobs", "POST")).status).toBe(404);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: true }))
        .status,
    ).toBe(404);
  });

  it("checkpoints pages, resumes a lost lease, and restarts pagination on Plaid mutations", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    const cursors: unknown[] = [];
    let mutated = false;
    const plaid: PlaidRequest = async <T>(
      _env: Bindings,
      _path: string,
      body: PlaidRequestBody,
    ) => {
      cursors.push(body.cursor);
      if (body.cursor === "page-1" && !mutated) {
        mutated = true;
        throw new PlaidApiError(
          "Restart pagination",
          "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          400,
        );
      }
      const page = transactionPage();
      page.has_more = !body.cursor;
      page.next_cursor = body.cursor ? "finished" : "page-1";
      if (body.cursor) page.added = [];
      return page as T;
    };
    await fixture.deliver(job.id, plaid);
    expect(
      fixture.database.query("SELECT cursor FROM plaid_items").get(),
    ).toEqual({ cursor: null });
    // Simulate an isolate disappearing after it acquired the next page.
    fixture.database.run(
      "UPDATE job_runs SET status = 'running', lease_until = '2000-01-01'",
    );
    await scheduleJobs(fixture.bindings);
    await fixture.deliver(job.id, plaid);
    await fixture.deliver(job.id, plaid);
    await fixture.deliver(job.id, plaid);
    expect(cursors).toEqual([undefined, "page-1", undefined, "page-1"]);
    const history = await jobRunDetail(fixture.bindings.DB, job.id);
    expect(history?.logs.map((log) => log.message)).toContain(
      "Bank page saved.",
    );
    expect(history?.logs.map((log) => log.message)).toContain(
      "Bank pagination restarted.",
    );
    expect(
      fixture.database
        .query("SELECT status, added, restarts FROM job_runs")
        .get(),
    ).toEqual({ status: "succeeded", added: 1, restarts: 1 });
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database.query("SELECT cursor FROM plaid_items").get(),
    ).toEqual({ cursor: "finished" });
  });

  it("keeps device copies whole across an interrupted, resumed, and restarted Plaid sync", async () => {
    const fixture = await queuedFixture();
    const plaidTransaction = (id: string, amount: number) => {
      const transaction = transactionPage().added[0];
      if (!transaction) throw new Error("Missing transaction fixture.");
      return { ...transaction, amount, transaction_id: id };
    };
    const device = new Map<string, number>();
    let cursor: string | null = null;
    const pullDevice = async () => {
      for (;;) {
        const { body }: { body: FinanceTransactionChanges } = await jsonRequest(
          fixture.app,
          fixture.bindings,
          `/transactions/changes${cursor ? `?cursor=${cursor}` : ""}`,
          "GET",
        );
        for (const transaction of body.transactions)
          device.set(transaction.id, transaction.amount);
        for (const id of body.removedIds) device.delete(id);
        cursor = body.cursor;
        if (!body.more) return;
      }
    };
    const server = () =>
      new Map(
        (
          fixture.database
            .query(
              "SELECT id, amount FROM plaid_transactions WHERE source_status = 'active'",
            )
            .all() as { amount: number; id: string }[]
        ).map(({ amount, id }) => [id, amount]),
      );
    let failSecondPage = true;
    let mutateOnce = true;
    const plaid: PlaidRequest = async <T>(
      _env: Bindings,
      _path: string,
      body: PlaidRequestBody,
    ) => {
      const page = transactionPage();
      if (!body.cursor) {
        page.added = [plaidTransaction("a", 1), plaidTransaction("b", 2)];
        page.has_more = true;
        page.next_cursor = "page-1";
        return page as T;
      }
      if (failSecondPage) {
        failSecondPage = false;
        throw new PlaidApiError("Try later", "INTERNAL_SERVER_ERROR", 500);
      }
      if (mutateOnce) {
        mutateOnce = false;
        throw new PlaidApiError(
          "Restart pagination",
          "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          400,
        );
      }
      page.added = [plaidTransaction("c", 3)];
      page.modified = [plaidTransaction("a", 10)];
      page.removed = [{ transaction_id: "b" }];
      page.next_cursor = "finished";
      return page as T;
    };
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    // The first page lands; the second fails and the job waits to retry.
    await fixture.deliver(job.id, plaid);
    await pullDevice();
    expect(device.size).toBe(2);
    expect(device).toEqual(server());
    // The retry resumes at the saved Plaid cursor, then Plaid asks for a
    // restart from it; the replayed first page rewrites its rows.
    const status = () =>
      (
        fixture.database.query("SELECT status FROM job_runs").get() as {
          status: string;
        }
      ).status;
    for (let attempt = 0; attempt < 10 && status() !== "succeeded"; attempt++) {
      fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
      await fixture.deliver(job.id, plaid);
      // A device may pull between any two attempts.
      await pullDevice();
    }
    expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual(
      { status: "succeeded" },
    );
    // Both interruptions happened.
    expect([failSecondPage, mutateOnce]).toEqual([false, false]);
    await pullDevice();
    expect(device).toEqual(server());
    expect(device.size).toBe(2);
    expect(
      device.get(
        (
          fixture.database
            .query(
              "SELECT id FROM plaid_transactions WHERE plaid_transaction_id = 'a'",
            )
            .get() as { id: string }
        ).id,
      ),
    ).toBe(10);
  });

  it("backs off transient failures, stops after five attempts, and allows a fresh manual retry", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    let calls = 0;
    const failing: PlaidRequest = async () => {
      calls++;
      throw new PlaidApiError("Try later", "INTERNAL_SERVER_ERROR", 500);
    };
    await fixture.deliver(job.id, failing);
    await fixture.deliver(job.id, failing);
    expect(calls).toBe(1);
    for (let attempt = 1; attempt < 5; attempt++) {
      fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
      await fixture.deliver(job.id, failing);
    }
    expect(
      fixture.database.query("SELECT status, failures FROM job_runs").get(),
    ).toEqual({ status: "failed", failures: 5 });
    expect(
      fixture.database
        .query("SELECT status, error_code FROM plaid_items")
        .get(),
    ).toEqual({ status: "error", error_code: "INTERNAL_SERVER_ERROR" });
    // Only the final failure is recorded on the connection, at the job's end.
    const { finished_at } = fixture.database
      .query("SELECT finished_at FROM job_runs")
      .get() as { finished_at: string };
    expect(
      fixture.database
        .query("SELECT last_failed_sync_at FROM plaid_items")
        .get(),
    ).toEqual({ last_failed_sync_at: finished_at });
    const retry = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    expect(retry.body.id).not.toBe(job.id);
    await fixture.deliver(retry.body.id);
    expect(
      fixture.database.query("SELECT status FROM plaid_items").get(),
    ).toEqual({ status: "active" });
  });

  it("cancels pending jobs for deleted organizations and never schedules them", async () => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    fixture.database.run(
      "UPDATE organization SET deletedAt = '2026-01-01' WHERE id = 'org_user-1'",
    );
    await fixture.deliver(job.id, async () => {
      throw new Error("Must not contact Plaid");
    });
    expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual(
      { status: "cancelled" },
    );
    fixture.messages.length = 0;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toHaveLength(0);
  });
});

it.each(["active", "error"])(
  "restores %s status and releases the disconnect claim when Plaid fails",
  async (status) => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    fixture.database.query("UPDATE plaid_items SET status = ?").run(status);
    const app = testApp("org_user-1", async () => {
      throw new PlaidApiError("Unavailable", "INTERNAL_SERVER_ERROR", 500);
    });
    const result = await jsonRequest(
      app,
      fixture.bindings,
      `/connections/${fixture.id}`,
      "DELETE",
    );
    expect(result.status).toBe(502);
    expect(
      fixture.database
        .query(
          "SELECT status, daily_sync, disconnect_lease_until FROM plaid_items",
        )
        .get(),
    ).toEqual({ status, daily_sync: 1, disconnect_lease_until: null });
    expect(
      fixture.database
        .query(
          "SELECT id FROM activity_events WHERE action = 'finance.connection_disconnected'",
        )
        .all(),
    ).toEqual([]);
    expect((await fixture.request("/sync-jobs", "POST")).status).toBe(202);
  },
);

it("records connection changes in shared activity with Finance reader permissions and deletion retention", async () => {
  const fixture = await queuedFixture();
  await fixture.request("/sync-settings", "PATCH", { dailySync: true });
  await fixture.request("/sync-settings", "PATCH", { dailySync: true });
  const denied = await findActivity(
    fixture.bindings.DB,
    "org_user-1",
    undefined,
    undefined,
    false,
    "finance_connection",
  );
  expect(denied?.events).toEqual([]);
  const page = await findActivity(
    fixture.bindings.DB,
    "org_user-1",
    undefined,
    undefined,
    true,
    "finance_connection",
  );
  expect(page?.events.map(({ action }) => action)).toEqual([
    "finance.daily_sync_changed",
    "finance.connection_created",
  ]);
  expect(page?.events[0]).toMatchObject({
    action: "finance.daily_sync_changed",
    actor: { id: "user-1", email: "person@example.com" },
    details: { before: false, after: true },
  });
  const started = await fixture.request<{ id: string }>("/sync-jobs", "POST");
  await fixture.request("/sync-jobs", "POST");
  expect(
    fixture.database
      .query(
        "SELECT count(*) AS count FROM activity_events WHERE action = 'finance.sync_requested'",
      )
      .get(),
  ).toEqual({ count: 1 });
  await fixture.deliver(started.body.id);
  await fixture.request("", "DELETE");
  expect(
    fixture.database
      .query(
        "SELECT count(*) AS count FROM activity_events WHERE action = 'finance.connection_disconnected'",
      )
      .get(),
  ).toEqual({ count: 1 });
  await fixture.request("/data", "DELETE");
  // Only the record of the deletion itself outlives the connection.
  expect(
    fixture.database
      .query(
        "SELECT action FROM activity_events WHERE root_type = 'finance_connection'",
      )
      .all(),
  ).toEqual([{ action: "finance.connection_data_deleted" }]);
});

it.each(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"])(
  "finishes an expired disconnect after Plaid already removed the Item (%s)",
  async (code) => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    fixture.database
      .query(`UPDATE plaid_items SET status = 'disconnecting',
      disconnect_lease_until = ?`)
      .run(new Date(Date.now() + 60_000).toISOString());
    let removals = 0;
    const app = testApp("org_user-1", async () => {
      removals++;
      throw new PlaidApiError("Item already removed", code, 400);
    });
    const disconnect = () =>
      jsonRequest(
        app,
        fixture.bindings,
        `/connections/${fixture.id}`,
        "DELETE",
      );
    expect((await disconnect()).status).toBe(409);
    expect(removals).toBe(0);
    fixture.database
      .query("UPDATE plaid_items SET disconnect_lease_until = ?")
      .run(new Date(Date.now() - 60_000).toISOString());
    expect((await disconnect()).status).toBe(204);
    expect(removals).toBe(1);
    expect(
      fixture.database
        .query(`SELECT status, daily_sync, access_token_ciphertext,
      disconnect_lease_until FROM plaid_items`)
        .get(),
    ).toEqual({
      status: "disconnected",
      daily_sync: 0,
      access_token_ciphertext: "",
      disconnect_lease_until: null,
    });
    expect(
      fixture.database
        .query(`SELECT count(*) AS count FROM activity_events
      WHERE action = 'finance.connection_disconnected'`)
        .get(),
    ).toEqual({ count: 1 });
  },
);

it.each(["queued", "backoff", "expired"])(
  "disconnects by cancelling %s work without requiring queue delivery",
  async (state) => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    if (state === "backoff")
      fixture.database
        .query("UPDATE job_runs SET available_at = ?")
        .run(new Date(Date.now() + 8 * 60_000).toISOString());
    if (state === "expired")
      fixture.database
        .query("UPDATE job_runs SET status = 'running', lease_until = ?")
        .run(new Date(Date.now() - 60_000).toISOString());
    expect((await fixture.request("", "DELETE")).status).toBe(204);
    expect(
      fixture.database
        .query("SELECT status, error_code, lease_until FROM job_runs")
        .get(),
    ).toEqual({
      status: "cancelled",
      error_code: "SYNC_CANCELLED",
      lease_until: null,
    });
    let calls = 0;
    await fixture.deliver(job.id, async <T>() => {
      calls++;
      return transactionPage() as T;
    });
    expect(calls).toBe(0);
    expect((await fixture.request("/data", "DELETE")).status).toBe(204);
  },
);

it("finishes disconnecting after a lost Plaid removal response", async () => {
  const fixture = await queuedFixture();
  let calls = 0;
  const app = testApp("org_user-1", async () => {
    if (++calls === 1) throw new Error("Response lost after removal");
    throw new PlaidApiError("Already removed", "ITEM_NOT_FOUND", 400);
  });
  const disconnect = () =>
    jsonRequest(app, fixture.bindings, `/connections/${fixture.id}`, "DELETE");
  expect((await disconnect()).status).toBe(500);
  expect(
    fixture.database.query("SELECT status FROM plaid_items").get(),
  ).toEqual({ status: "active" });
  expect((await disconnect()).status).toBe(204);
  expect(
    fixture.database.query("SELECT status FROM plaid_items").get(),
  ).toEqual({ status: "disconnected" });
});
