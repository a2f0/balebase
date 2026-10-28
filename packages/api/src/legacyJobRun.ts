import { type JobRow, toJobRun } from "./jobRuns";

// Installed apps from before background jobs wait for a run in one request
// and treat every successful response as completed work: app 0.1.71 and
// earlier sync bank connections through POST /api/finance/connections/:id/sync,
// and 0.1.73 and earlier run admin jobs through POST /api/admin/jobs/:jobId/run.

/**
 * Polls a run until it finishes, returning its last row: still queued or
 * running once the polls run out, or null if the run is gone.
 */
export async function waitForRun<Row extends JobRow>(
  database: D1Database,
  id: string,
  polls: number,
  pause: () => Promise<void>,
) {
  let row: Row | null = null;
  for (let poll = 0; poll < polls; poll++) {
    row = await database
      .prepare("SELECT * FROM job_runs WHERE id = ?")
      .bind(id)
      .first<Row>();
    if (!row || !runActive(row)) return row;
    await pause();
  }
  return row;
}

export function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForLegacyJob(
  database: D1Database,
  id: string,
  pause: () => Promise<void> = () => delay(1000),
) {
  const row = await waitForRun(database, id, 25, pause);
  if (!row || runActive(row)) return null;
  const run = toJobRun(row);
  return {
    runId: run.runId,
    jobId: run.jobId,
    status:
      run.status === "succeeded" ? ("succeeded" as const) : ("failed" as const),
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.finishedAt ?? run.createdAt,
    durationMs: run.durationMs ?? 0,
    result: run.output,
    ...(run.error ? { error: run.error } : {}),
  };
}

function runActive(row: JobRow) {
  return row.status === "queued" || row.status === "running";
}
