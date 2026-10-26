import { type PlaidItemRow, syncPlaidPage } from "./financeSync";
import { dispatchSyncJob, type SyncJobRow } from "./financeSyncJobs";
import {
  PlaidApiError,
  type PlaidRequest,
  plaidRequest,
  type TransactionsSyncResponse,
} from "./plaid";
import type { Bindings } from "./types";

/** Longer than Queues' 15-minute invocation limit, so an expired owner cannot still write. */
const leaseMilliseconds = 20 * 60 * 1000;

export async function consumeFinanceSync(
  batch: MessageBatch<{ jobId: string }>,
  env: Bindings,
  requestPlaid: PlaidRequest = plaidRequest,
) {
  for (const message of batch.messages) {
    try {
      await runSyncPage(env, message.body.jobId, requestPlaid);
      message.ack();
    } catch {
      console.error({
        event: "finance_sync_delivery_failed",
        jobId: message.body.jobId,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function runSyncPage(
  env: Bindings,
  id: string,
  requestPlaid: PlaidRequest,
) {
  const now = new Date().toISOString();
  const job = await env.DB.prepare(`UPDATE finance_sync_jobs
    SET status = 'running', lease_until = ?, failures = failures + 1
    WHERE id = ? AND ((status = 'queued' AND available_at <= ?)
      OR (status = 'running' AND lease_until <= ?)) RETURNING *`)
    .bind(new Date(Date.now() + leaseMilliseconds).toISOString(), id, now, now)
    .first<SyncJobRow>();
  if (!job) return;
  const item = await env.DB.prepare(`SELECT item.* FROM plaid_items item
    JOIN organization org ON org.id = item.organization_id
    WHERE item.id = ? AND item.organization_id = ?
      AND item.status IN ('active', 'error') AND org.deletedAt IS NULL`)
    .bind(job.connection_id, job.organization_id)
    .first<PlaidItemRow>();
  if (!item) {
    await env.DB.prepare(`UPDATE finance_sync_jobs SET status = 'cancelled', finished_at = ?, lease_until = NULL
      WHERE id = ?`)
      .bind(now, id)
      .run();
    return;
  }
  try {
    if (job.failures > 5)
      throw new PlaidApiError(
        "Sync retry limit reached.",
        "SYNC_RETRY_LIMIT",
        400,
      );
    if (job.pages >= 2000)
      throw new PlaidApiError(
        "Sync page limit reached.",
        "SYNC_PAGE_LIMIT",
        400,
      );
    const page = await syncPlaidPage(
      env,
      job.organization_id,
      { ...item, cursor: job.cursor },
      requestPlaid,
    );
    await checkpoint(env, job, page);
  } catch (error) {
    await retryOrFail(env, job, error);
  }
}

async function checkpoint(
  env: Bindings,
  job: SyncJobRow,
  page: TransactionsSyncResponse,
) {
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`UPDATE finance_sync_jobs
    SET cursor = ?, added = added + ?, modified = modified + ?, removed = removed + ?,
      pages = pages + 1, failures = 0, status = ?, lease_until = NULL, available_at = ?,
      error_code = NULL, error_message = NULL, finished_at = ? WHERE id = ?`).bind(
      page.next_cursor,
      page.added.length,
      page.modified.length,
      page.removed.length,
      page.has_more ? "queued" : "succeeded",
      now,
      page.has_more ? null : now,
      job.id,
    ),
  ];
  if (!page.has_more) {
    statements.push(
      env.DB.prepare(`UPDATE plaid_items SET cursor = ?, status = 'active',
      error_code = NULL, error_message = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?`).bind(
        page.next_cursor,
        now,
        now,
        job.connection_id,
      ),
    );
  }
  await env.DB.batch(statements);
  if (page.has_more) await dispatchSyncJob(env, job.id);
}

async function retryOrFail(env: Bindings, job: SyncJobRow, error: unknown) {
  const plaid = error instanceof PlaidApiError ? error : null;
  if (
    plaid?.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
    job.restarts < 2
  ) {
    await env.DB.prepare(`UPDATE finance_sync_jobs SET cursor = initial_cursor,
      added = 0, modified = 0, removed = 0, pages = 0, failures = 0, restarts = restarts + 1,
      status = 'queued', lease_until = NULL WHERE id = ?`)
      .bind(job.id)
      .run();
    await dispatchSyncJob(env, job.id);
    return;
  }
  const retryable = !plaid || plaid.status >= 500 || plaid.status === 429;
  const retry = retryable && job.failures < 5;
  const now = new Date().toISOString();
  const available = new Date(
    Date.now() + 60_000 * 2 ** (job.failures - 1),
  ).toISOString();
  const code = plaid?.code ?? "SYNC_ERROR";
  const message = plaid?.message ?? "Could not sync this connection.";
  const statements = [
    env.DB.prepare(`UPDATE finance_sync_jobs SET status = ?,
    error_code = ?, error_message = ?, available_at = ?, lease_until = NULL, finished_at = ? WHERE id = ?`).bind(
      retry ? "queued" : "failed",
      code,
      message,
      available,
      retry ? null : now,
      job.id,
    ),
  ];
  if (!retry) {
    statements.push(
      env.DB.prepare(`UPDATE plaid_items SET status = 'error', error_code = ?,
      error_message = ?, updated_at = ? WHERE id = ?`).bind(
        code,
        message,
        now,
        job.connection_id,
      ),
    );
  }
  await env.DB.batch(statements);
  // The outbox schedules backoff retries; no browser or live queue message is needed.
  console.error({
    event: "finance_sync_attempt_failed",
    jobId: job.id,
    retry,
    code,
  });
}
