import type { FinanceSyncJob } from "@balebase/validators/finance";
import { dispatchJob, type JobRow } from "../jobs/jobRuns";
import {
  type ActivityActor,
  activityBatch,
  activityStatement,
} from "../shared/activity";
import type { Bindings } from "../types";
import { PlaidApiError } from "./plaid";

export interface SyncJobRow extends JobRow {
  connection_id: string;
  organization_id: string;
  source: FinanceSyncJob["source"];
}

export function isSyncJob(job: JobRow): job is SyncJobRow {
  return (
    job.job_id === "syncFinanceConnection" &&
    job.connection_id !== null &&
    job.organization_id !== null &&
    (job.source === "manual" || job.source === "daily")
  );
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
    .prepare(`SELECT * FROM job_runs
    WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(connectionId)
    .first<SyncJobRow>();
  return row ? toSyncJob(row) : null;
}

export async function enqueueSync(
  env: Bindings,
  organizationId: string,
  connectionId: string,
  source: FinanceSyncJob["source"],
  actor: ActivityActor | null,
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
  const connection = actor
    ? await env.DB.prepare(
        "SELECT institution_name FROM plaid_items WHERE id = ? AND organization_id = ?",
      )
        .bind(connectionId, organizationId)
        .first<{ institution_name: string | null }>()
    : null;
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO job_runs
      (id, job_id, connection_id, organization_id, source, requested_by, initial_cursor, cursor, available_at, created_at)
      SELECT ?, 'syncFinanceConnection', item.id, item.organization_id, ?, ?, item.cursor, item.cursor, ?, ?
      FROM plaid_items item JOIN organization org ON org.id = item.organization_id
      WHERE item.id = ? AND item.organization_id = ? AND org.deletedAt IS NULL
        AND item.status IN ('active', 'error')
        AND (? = 'manual' OR item.daily_sync = 1)`).bind(
      id,
      source,
      actor?.userId ?? null,
      now,
      now,
      connectionId,
      organizationId,
      source,
    ),
  ];
  if (actor)
    statements.push(
      activityStatement(
        env.DB,
        {
          action: "finance.sync_requested",
          actorId: actor.userId,
          occurredAt: now,
          organizationId,
          root: {
            id: connectionId,
            label: connection?.institution_name ?? "Bank connection",
            type: "finance_connection",
          },
          subject: { id, type: "finance_sync_job" },
          details: { jobId: id },
        },
        { sql: "changes() > 0", bindings: [] },
      ),
    );
  statements.push(
    env.DB.prepare(`UPDATE plaid_items SET last_daily_sync_date = ?
      WHERE id = ? AND ? = 'daily'
        AND EXISTS (SELECT 1 FROM job_runs WHERE id = ?)`).bind(
      now.slice(0, 10),
      connectionId,
      source,
      id,
    ),
    env.DB.prepare(`SELECT * FROM job_runs
      WHERE connection_id = ? AND organization_id = ?
        AND (id = ? OR status IN ('queued', 'running'))
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(
      connectionId,
      organizationId,
      id,
    ),
  );
  // Select in the same transaction: a fast consumer cannot finish a shared job
  // between an ignored duplicate insert and this request finding that job.
  const results = await activityBatch(env.DB, actor?.apiKey, statements);
  const job = results.at(-1)?.results[0] as SyncJobRow | undefined;
  if (!job) return null;
  if (job.status === "queued") await dispatchJob(env, job.id);
  return job;
}

/** Schedule each opted-in connection once per UTC day. */
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
      AND NOT EXISTS (SELECT 1 FROM job_runs job WHERE job.connection_id = item.id
        AND job.status IN ('queued', 'running'))
    ORDER BY item.last_daily_sync_date, item.id LIMIT 100`)
      .bind(now.slice(0, 10))
      .all<{ id: string; organization_id: string }>();
  for (const item of due.results) {
    await enqueueSync(env, item.organization_id, item.id, "daily", null, now);
  }
  return due.results.length;
}
