import { type JobRow, toJobRun } from "./jobRuns";

/** Old installed apps treat every successful HTTP response as completed work. */
export async function waitForLegacyJob(
  database: D1Database,
  id: string,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 250)),
) {
  for (let poll = 0; poll < 100; poll++) {
    const row = await database
      .prepare("SELECT * FROM job_runs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    if (!row) return null;
    const run = toJobRun(row);
    if (run.status !== "queued" && run.status !== "running") {
      return {
        runId: run.runId,
        jobId: run.jobId,
        status:
          run.status === "succeeded"
            ? ("succeeded" as const)
            : ("failed" as const),
        startedAt: run.startedAt ?? run.createdAt,
        finishedAt: run.finishedAt ?? run.createdAt,
        durationMs: run.durationMs ?? 0,
        result: run.output,
        ...(run.error ? { error: run.error } : {}),
      };
    }
    await pause();
  }
  return null;
}
