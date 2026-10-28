import { JobOutputSchema, type JobRun } from "@balebase/validators/adminJobs";
import { captureApiError } from "./diagnostics";
import type { Bindings } from "./types";

export interface JobRow {
  id: string;
  job_id: string;
  connection_id: string | null;
  organization_id: string | null;
  source: JobRun["source"];
  requested_by: string | null;
  status: JobRun["status"];
  attempts: number;
  failures: number;
  lease_until: string | null;
  available_at: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  output_json: string | null;
  initial_cursor: string | null;
  cursor: string | null;
  added: number;
  modified: number;
  removed: number;
  pages: number;
  restarts: number;
}

export function toJobRun(row: JobRow): JobRun {
  return {
    runId: row.id,
    jobId: row.job_id,
    status: row.status,
    source: row.source,
    requestedBy: row.requested_by,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    availableAt: row.available_at,
    durationMs:
      row.started_at && row.finished_at
        ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.started_at))
        : null,
    errorCode: row.error_code,
    // Provider responses and thrown exceptions never become administrative log text.
    error:
      row.status !== "cancelled" && row.error_code
        ? "Job encountered an error; some work may have completed. Review the saved logs before retrying."
        : null,
    output: row.output_json
      ? JobOutputSchema.parse(JSON.parse(row.output_json) as unknown)
      : null,
  };
}

/** Keep the existing queue binding/name so queued finance messages survive rollout. */
export async function dispatchJob(env: Bindings, jobId: string) {
  if (!env.FINANCE_SYNC_QUEUE)
    throw new Error("Background job queue is not configured.");
  try {
    // The existing wire field is named jobId; it identifies a run, not its job type.
    await env.FINANCE_SYNC_QUEUE.send({ jobId });
  } catch (error) {
    console.error({ event: "job_dispatch_failed", jobId }, error);
    // D1 is the outbox. The five-minute scheduler retries delivery.
  }
}

/** A lease outlives the queue invocation's 15-minute wall-clock limit. */
export function claimJob(database: D1Database, id: string) {
  const now = new Date().toISOString();
  return database
    .prepare(`UPDATE job_runs SET status = 'running', lease_until = ?,
    started_at = COALESCE(started_at, ?), attempts = attempts + 1, failures = failures + 1
    WHERE id = ? AND ((status = 'queued' AND available_at <= ?)
      OR (job_id = 'syncFinanceConnection' AND status = 'running' AND lease_until <= ?))
      AND NOT EXISTS (SELECT 1 FROM job_runs dependency
        WHERE dependency.id = job_runs.depends_on AND dependency.status IN ('queued', 'running'))
    RETURNING *`)
    .bind(new Date(Date.now() + 20 * 60_000).toISOString(), now, id, now, now)
    .first<JobRow>();
}

export async function recoverJobs(env: Bindings, timestamp = Date.now()) {
  const now = new Date(timestamp).toISOString();
  // Maintenance may have sent mail before interruption. Never replay it blindly.
  const interrupted =
    await env.DB.prepare(`UPDATE job_runs SET status = 'failed', finished_at = ?, lease_until = NULL,
    error_code = 'INTERRUPTED', error_message = 'Execution interrupted; review before retrying.'
    WHERE job_id <> 'syncFinanceConnection' AND status = 'running' AND lease_until <= ?`)
      .bind(now, now)
      .run();
  if (interrupted.meta.changes > 0)
    await captureApiError(
      new Error("Maintenance execution interrupted."),
      "job-error",
    );
  const pending = await env.DB.prepare(`SELECT id FROM job_runs
    WHERE ((status = 'queued' AND available_at <= ?)
      OR (job_id = 'syncFinanceConnection' AND status = 'running' AND lease_until <= ?))
      AND NOT EXISTS (SELECT 1 FROM job_runs dependency
        WHERE dependency.id = job_runs.depends_on AND dependency.status IN ('queued', 'running'))
    ORDER BY available_at, id LIMIT 100`)
    .bind(now, now)
    .all<{ id: string }>();
  for (const job of pending.results) await dispatchJob(env, job.id);
  await env.DB.prepare(`DELETE FROM job_runs WHERE id IN (
    SELECT id FROM job_runs WHERE finished_at < ? AND status IN ('succeeded', 'failed', 'cancelled')
    ORDER BY finished_at LIMIT 500)`)
    .bind(new Date(timestamp - 30 * 24 * 60 * 60_000).toISOString())
    .run();
  return pending.results.length;
}
