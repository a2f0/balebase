import type { FinanceSyncJob } from "@balebase/validators/finance";
import { PlaidApiError } from "./plaid";
import type { Bindings } from "./types";

export interface SyncJobRow {
  id: string;
  connection_id: string;
  organization_id: string;
  source: FinanceSyncJob["source"];
  status: FinanceSyncJob["status"];
  initial_cursor: string | null;
  cursor: string | null;
  added: number;
  modified: number;
  removed: number;
  pages: number;
  failures: number;
  restarts: number;
  created_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

export function toSyncJob(row: SyncJobRow): FinanceSyncJob {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    added: row.added,
    modified: row.modified,
    removed: row.removed,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
  };
}

export async function latestSyncJob(
  database: D1Database,
  connectionId: string,
) {
  const row = await database
    .prepare(`SELECT * FROM finance_sync_jobs
    WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(connectionId)
    .first<SyncJobRow>();
  return row ? toSyncJob(row) : null;
}

/** D1 is the outbox: a failed send or a terminated request is recovered by cron. */
export async function dispatchSyncJob(env: Bindings, jobId: string) {
  if (!env.FINANCE_SYNC_QUEUE)
    throw new Error("Finance sync queue is not configured.");
  try {
    await env.FINANCE_SYNC_QUEUE.send({ jobId });
  } catch {
    console.error({ event: "finance_sync_dispatch_failed", jobId });
  }
}

export async function enqueueSync(
  env: Bindings,
  organizationId: string,
  connectionId: string,
  source: FinanceSyncJob["source"],
  actor: string | null,
  now = new Date().toISOString(),
) {
  if (!env.FINANCE_SYNC_QUEUE) {
    throw new PlaidApiError(
      "Background sync is not configured.",
      "NOT_CONFIGURED",
      503,
    );
  }
  const id =
    source === "daily"
      ? `daily:${connectionId}:${now.slice(0, 10)}`
      : crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO finance_sync_jobs
      (id, connection_id, organization_id, source, actor, initial_cursor, cursor, available_at, created_at)
      SELECT ?, item.id, item.organization_id, ?, ?, item.cursor, item.cursor, ?, ?
      FROM plaid_items item JOIN organization org ON org.id = item.organization_id
      WHERE item.id = ? AND item.organization_id = ? AND org.deletedAt IS NULL
        AND item.status IN ('active', 'error')
        AND (? = 'manual' OR item.daily_sync = 1)`).bind(
      id,
      source,
      actor,
      now,
      now,
      connectionId,
      organizationId,
      source,
    ),
    env.DB.prepare(`UPDATE plaid_items SET last_daily_sync_date = ?
      WHERE id = ? AND ? = 'daily'
        AND EXISTS (SELECT 1 FROM finance_sync_jobs WHERE id = ?)`).bind(
      now.slice(0, 10),
      connectionId,
      source,
      id,
    ),
  ]);
  const job = await env.DB.prepare(`SELECT * FROM finance_sync_jobs
    WHERE connection_id = ? AND organization_id = ?
      AND (id = ? OR status IN ('queued', 'running'))
    ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(connectionId, organizationId, id)
    .first<SyncJobRow>();
  if (!job) return null;
  if (job.status === "queued") await dispatchSyncJob(env, job.id);
  return job;
}

/** Five-minute outbox recovery also schedules each opted-in connection once per UTC day. */
export async function scheduleFinanceSync(
  env: Bindings,
  timestamp = Date.now(),
) {
  const now = new Date(timestamp).toISOString();
  const due =
    await env.DB.prepare(`SELECT item.id, item.organization_id FROM plaid_items item
    JOIN organization org ON org.id = item.organization_id
    WHERE item.daily_sync = 1 AND item.status IN ('active', 'error')
      AND org.deletedAt IS NULL
      AND (item.last_daily_sync_date IS NULL OR item.last_daily_sync_date < ?)
      AND NOT EXISTS (SELECT 1 FROM finance_sync_jobs job WHERE job.connection_id = item.id
        AND job.status IN ('queued', 'running'))
    ORDER BY item.last_daily_sync_date, item.id LIMIT 100`)
      .bind(now.slice(0, 10))
      .all<{ id: string; organization_id: string }>();
  for (const item of due.results) {
    await enqueueSync(env, item.organization_id, item.id, "daily", null, now);
  }
  const pending = await env.DB.prepare(`SELECT id FROM finance_sync_jobs
    WHERE (status = 'queued' AND available_at <= ?)
      OR (status = 'running' AND lease_until <= ?)
    ORDER BY available_at LIMIT 100`)
    .bind(now, now)
    .all<{ id: string }>();
  for (const job of pending.results) await dispatchSyncJob(env, job.id);
  return { scheduled: due.results.length, dispatched: pending.results.length };
}
