import { describe, expect, it } from "bun:test";
import { consumeJobs } from "../jobs/jobWorker";
import { findActivity } from "../shared/activity";
import {
  createFixture,
  jsonRequest,
  transactionPage,
} from "../testing/financeFixture";
import type { Bindings } from "../types";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
  type TransactionsSyncResponse,
} from "./plaid";

interface ProviderEvent {
  action: string;
  actor_source: string | null;
  actor_type: string;
  actor_user_id: string | null;
  causation_id: string | null;
  causation_type: string | null;
  details: Record<string, unknown>;
  root_id: string;
  subject_id: string;
}

/** A connection whose sync jobs are delivered by hand, with any Plaid. */
async function connectionFixture() {
  const fixture = await createFixture();
  fixture.bindings.FINANCE_SYNC_QUEUE = {
    send: async () => {},
  } as unknown as Queue<{ jobId: string }>;
  const exchange = await jsonRequest<{ connectionId: string }>(
    fixture.app,
    fixture.bindings,
    "/exchange",
    "POST",
    { institutionName: "First Test Bank", publicToken: "public-sandbox-test" },
  );
  const id = exchange.body.connectionId;
  /** Requests a sync job and delivers it once to `plaid`. */
  const sync = async (plaid: PlaidRequest = fixture.requestPlaid) => {
    const job = await jsonRequest<{ id: string }>(
      fixture.app,
      fixture.bindings,
      `/connections/${id}/sync-jobs`,
      "POST",
    );
    await deliver(job.body.id, plaid);
    return job.body.id;
  };
  const deliver = (jobId: string, plaid: PlaidRequest) =>
    consumeJobs(
      {
        messages: [{ ack() {}, body: { jobId }, retry() {} }],
      } as unknown as MessageBatch<{ jobId: string }>,
      fixture.bindings,
      plaid,
    );
  const events = (action: string) =>
    fixture.database
      .query<Omit<ProviderEvent, "details"> & { details: string }, [string]>(
        `SELECT action, actor_source, actor_type, actor_user_id, causation_id,
                causation_type, details, root_id, subject_id
         FROM activity_events WHERE action = ? ORDER BY id`,
      )
      .all(action)
      .map(
        (row): ProviderEvent => ({
          ...row,
          details: JSON.parse(row.details) as Record<string, unknown>,
        }),
      );
  return { ...fixture, deliver, events, id, sync };
}

function failing(code: string, status: number): PlaidRequest {
  return async () => {
    throw new PlaidApiError("Plaid failed.", code, status);
  };
}

function pages(page: () => TransactionsSyncResponse): PlaidRequest {
  return async <T>(_env: Bindings, _path: string, _body: PlaidRequestBody) =>
    page() as T;
}

describe("Plaid connection history", () => {
  it("records each status change by Plaid, once, and none for the same state", async () => {
    const fixture = await connectionFixture();
    const loginJob = await fixture.sync(failing("ITEM_LOGIN_REQUIRED", 400));
    expect(
      fixture.database
        .query("SELECT status, error_code FROM plaid_items")
        .get(),
    ).toEqual({ error_code: "ITEM_LOGIN_REQUIRED", status: "error" });
    expect(fixture.events("finance.connection_status_changed")).toEqual([
      {
        action: "finance.connection_status_changed",
        actor_source: "plaid",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: loginJob,
        causation_type: "job_run",
        details: {
          after: { errorCode: "ITEM_LOGIN_REQUIRED", status: "error" },
          before: { errorCode: null, status: "active" },
        },
        root_id: fixture.id,
        subject_id: fixture.id,
      },
    ]);
    // The same failure again leaves the connection as it was.
    await fixture.sync(failing("ITEM_LOGIN_REQUIRED", 400));
    expect(fixture.events("finance.connection_status_changed")).toHaveLength(1);
    // A different error is a change; recovery is another.
    await fixture.sync(failing("INSTITUTION_DOWN", 400));
    const recoveryJob = await fixture.sync();
    expect(
      fixture.events("finance.connection_status_changed").map((event) => ({
        causation: event.causation_id,
        details: event.details,
      })),
    ).toEqual([
      {
        causation: loginJob,
        details: {
          after: { errorCode: "ITEM_LOGIN_REQUIRED", status: "error" },
          before: { errorCode: null, status: "active" },
        },
      },
      {
        causation: expect.any(String),
        details: {
          after: { errorCode: "INSTITUTION_DOWN", status: "error" },
          before: { errorCode: "ITEM_LOGIN_REQUIRED", status: "error" },
        },
      },
      {
        causation: recoveryJob,
        details: {
          after: { errorCode: null, status: "active" },
          before: { errorCode: "INSTITUTION_DOWN", status: "error" },
        },
      },
    ]);
    // A healthy sync of a healthy connection records nothing.
    await fixture.sync();
    expect(fixture.events("finance.connection_status_changed")).toHaveLength(3);
  });

  it("records nothing while retrying, and one change when retries run out", async () => {
    const fixture = await connectionFixture();
    const outage = failing("INTERNAL_SERVER_ERROR", 500);
    const job = await fixture.sync(outage);
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(fixture.events("finance.connection_status_changed")).toEqual([]);
      fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
      await fixture.deliver(job, outage);
    }
    expect(
      fixture.database.query("SELECT status, failures FROM job_runs").get(),
    ).toEqual({ failures: 5, status: "failed" });
    expect(fixture.events("finance.connection_status_changed")).toMatchObject([
      {
        causation_id: job,
        details: {
          after: { errorCode: "INTERNAL_SERVER_ERROR", status: "error" },
          before: { errorCode: null, status: "active" },
        },
      },
    ]);
  });

  it("keeps the connection's status when its event cannot be recorded", async () => {
    const fixture = await connectionFixture();
    fixture.database.exec(`CREATE TRIGGER fail_status_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'finance.connection_status_changed'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    await fixture
      .sync(failing("ITEM_LOGIN_REQUIRED", 400))
      .catch(() => undefined);
    expect(
      fixture.database
        .query("SELECT status, error_code FROM plaid_items")
        .get(),
    ).toEqual({ error_code: null, status: "active" });
    expect(fixture.events("finance.connection_status_changed")).toEqual([]);
  });

  it("records the transactions Plaid removes, once", async () => {
    const fixture = await connectionFixture();
    await fixture.sync();
    const transaction = fixture.database
      .query<{ id: string }, []>("SELECT id FROM plaid_transactions")
      .get();
    const removal = () => {
      const page = transactionPage();
      page.added = [];
      page.removed = [
        { transaction_id: "transaction-test-1" },
        { transaction_id: "transaction-unknown" },
      ];
      return page;
    };
    const job = await fixture.sync(pages(removal));
    expect(
      fixture.database
        .query("SELECT source_status FROM plaid_transactions")
        .get(),
    ).toEqual({ source_status: "removed" });
    expect(fixture.events("finance.transactions_removed")).toEqual([
      {
        action: "finance.transactions_removed",
        actor_source: "plaid",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: `${job}:0:0`,
        causation_type: "plaid_sync_page",
        details: { count: 1, transactionIds: [transaction?.id] },
        root_id: fixture.id,
        subject_id: fixture.id,
      },
    ]);
    // Plaid repeating the removal changes nothing and records nothing.
    await fixture.sync(pages(removal));
    expect(fixture.events("finance.transactions_removed")).toHaveLength(1);
  });

  it("records the accounts and transactions a reconnection carries over", async () => {
    const fixture = await connectionFixture();
    await fixture.sync();
    const before = fixture.database
      .query<{ account: string; id: string }, []>(
        "SELECT account_record_id AS account, id FROM plaid_transactions",
      )
      .get();
    const disconnected = await fixture.app.request(
      `/api/finance/connections/${fixture.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const reconnected = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    const newId = reconnected.body.connectionId;
    // Plaid's IDs change with the new Item; the rows match by their values.
    const samePage = pages(() => transactionPage("2"));
    const job = await jsonRequest<{ id: string }>(
      fixture.app,
      fixture.bindings,
      `/connections/${newId}/sync-jobs`,
      "POST",
    );
    await fixture.deliver(job.body.id, samePage);
    expect(
      fixture.database
        .query(
          `SELECT account_record_id AS account, id,
                  plaid_item_record_id AS item
           FROM plaid_transactions`,
        )
        .all(),
    ).toEqual([{ ...before, item: newId }]);
    expect(fixture.events("finance.records_carried_over")).toEqual([
      {
        action: "finance.records_carried_over",
        actor_source: "plaid",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: `${job.body.id}:0:0`,
        causation_type: "plaid_sync_page",
        details: {
          accountCount: 1,
          fromConnectionId: fixture.id,
          fromInstitutionName: "First Test Bank",
          transactionCount: 1,
        },
        root_id: newId,
        subject_id: fixture.id,
      },
    ]);
    // Syncing the same rows again carries nothing over.
    const again = await jsonRequest<{ id: string }>(
      fixture.app,
      fixture.bindings,
      `/connections/${newId}/sync-jobs`,
      "POST",
    );
    await fixture.deliver(again.body.id, samePage);
    expect(fixture.events("finance.records_carried_over")).toHaveLength(1);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("carries nothing over when its event cannot be recorded", async () => {
    const fixture = await connectionFixture();
    await fixture.sync();
    const disconnected = await fixture.app.request(
      `/api/finance/connections/${fixture.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const reconnected = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    fixture.database.exec(`CREATE TRIGGER fail_carry_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'finance.records_carried_over'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const job = await jsonRequest<{ id: string }>(
      fixture.app,
      fixture.bindings,
      `/connections/${reconnected.body.connectionId}/sync-jobs`,
      "POST",
    );
    await fixture.deliver(
      job.body.id,
      pages(() => transactionPage("2")),
    );
    expect(
      fixture.database
        .query("SELECT plaid_item_record_id AS item FROM plaid_transactions")
        .all(),
    ).toEqual([{ item: fixture.id }]);
  });

  it("shows Plaid's changes only to people with Finance access", async () => {
    const fixture = await connectionFixture();
    await fixture.sync(failing("ITEM_LOGIN_REQUIRED", 400));
    const read = (finance: boolean) =>
      findActivity(
        fixture.bindings.DB,
        "org_user-1",
        undefined,
        { id: fixture.id, type: "finance_connection" },
        finance,
      );
    expect((await read(false))?.events).toEqual([]);
    expect((await read(true))?.events).toMatchObject([
      {
        action: "finance.connection_status_changed",
        actor: { email: "", id: null, source: "plaid", type: "provider" },
      },
      { action: "finance.sync_requested" },
      { action: "finance.connection_created" },
    ]);
  });
});
