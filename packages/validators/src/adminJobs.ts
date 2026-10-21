import { z } from "zod";
import { route } from "./route";

const MaintenanceJobSchema = z.object({
  description: z.string(),
  id: z.string(),
  name: z.string(),
});
export type MaintenanceJob = z.infer<typeof MaintenanceJobSchema>;

/** One run; Workers Logs keeps its full record under the run ID. */
const MaintenanceRunSchema = z.object({
  durationMs: z.number(),
  /** Set when the job failed; some of its work may have completed. */
  error: z.string().optional(),
  finishedAt: z.string(),
  jobId: z.string(),
  /** What the job reported, or null; absent when it failed. */
  result: z.unknown().optional(),
  runId: z.string(),
  startedAt: z.string(),
  status: z.enum(["succeeded", "failed"]),
});
export type MaintenanceRun = z.infer<typeof MaintenanceRunSchema>;

export const adminJobsRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/jobs",
    response: z.object({ jobs: z.array(MaintenanceJobSchema) }),
  }),
  run: route({
    method: "POST",
    path: "/api/admin/jobs/:jobId/run",
    // The job's ID again, so a stray request cannot start it.
    body: z.object({ confirm: z.string() }),
    // Sent with status 500 when the job failed.
    response: z.object({ run: MaintenanceRunSchema }),
  }),
};
