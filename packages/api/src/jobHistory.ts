import {
  type adminJobsRoutes,
  JobLogDetailsSchema,
} from "@balebase/validators/adminJobs";
import type { RouteInput, RouteOutput } from "@balebase/validators/route";
import { type JobRow, toJobRun } from "./jobRuns";

function historyCursor(cursor: string) {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === "string")
    )
      return value as [string, string];
  } catch {
    /* Invalid cursors are rejected before running a query. */
  }
  return null;
}

export async function listJobRuns(
  database: D1Database,
  query: NonNullable<RouteInput<typeof adminJobsRoutes.runs>["query"]>,
) {
  const conditions: string[] = [];
  const values: string[] = [];
  if (query.jobId) {
    conditions.push("job_id = ?");
    values.push(query.jobId);
  }
  if (query.status) {
    conditions.push("status = ?");
    values.push(query.status);
  }
  if (query.cursor) {
    const cursor = historyCursor(query.cursor);
    if (!cursor) return null;
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor[0], cursor[0], cursor[1]);
  }
  const { results } = await database
    .prepare(`SELECT * FROM job_runs
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT 51`)
    .bind(...values)
    .all<JobRow>();
  const page = results.slice(0, 50);
  const last = page.at(-1);
  return {
    runs: page.map(toJobRun),
    nextCursor:
      results.length > 50 && last
        ? btoa(JSON.stringify([last.created_at, last.id]))
        : null,
  };
}

export async function jobRunDetail(
  database: D1Database,
  id: string,
  before?: string,
) {
  const row = await database
    .prepare("SELECT * FROM job_runs WHERE id = ?")
    .bind(id)
    .first<JobRow>();
  if (!row) return null;
  const { results } = await database
    .prepare(`SELECT * FROM job_logs WHERE run_id = ?
    ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT 201`)
    .bind(...(before ? [id, Number(before)] : [id]))
    .all<{
      id: number;
      occurred_at: string;
      level: "info" | "warn" | "error";
      message: string;
      details_json: string;
    }>();
  const page = results.slice(0, 200);
  return {
    run: toJobRun(row),
    nextBefore: results.length > 200 ? String(page.at(-1)?.id) : null,
    logs: page.toReversed().map((log) => ({
      id: log.id,
      occurredAt: log.occurred_at,
      level: log.level,
      message: log.message,
      details: JobLogDetailsSchema.parse(
        JSON.parse(log.details_json) as unknown,
      ),
    })),
  } satisfies RouteOutput<typeof adminJobsRoutes.detail>;
}
