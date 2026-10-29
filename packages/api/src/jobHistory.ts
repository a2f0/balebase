import {
  type adminJobsRoutes,
  JobLogDetailsSchema,
} from "@balebase/validators/adminJobs";
import type { RouteInput, RouteOutput } from "@balebase/validators/route";
import { type JobRow, toJobRun } from "./jobRuns";
import {
  cursorPage,
  decodeCursor,
  encodeCursor,
} from "./shared/cursorPagination";

const runPageSize = 50;
const logPageSize = 200;

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
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor, "createdAt", 500);
    if (!cursor) return null;
    conditions.push("(created_at, id) < (?, ?)");
    values.push(...cursor);
  }
  const { results } = await database
    .prepare(`SELECT * FROM job_runs
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...values, runPageSize + 1)
    .all<JobRow>();
  const page = cursorPage(results, runPageSize, (row) =>
    encodeCursor(row.created_at, row.id),
  );
  return {
    runs: page.items.map(toJobRun),
    nextCursor: page.nextCursor,
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
    ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...(before ? [id, Number(before)] : [id]), logPageSize + 1)
    .all<{
      id: number;
      occurred_at: string;
      level: "info" | "warn" | "error";
      message: string;
      details_json: string;
    }>();
  const page = cursorPage(results, logPageSize, (log) => String(log.id));
  return {
    run: toJobRun(row),
    nextBefore: page.nextCursor,
    logs: page.items.toReversed().map((log) => ({
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
