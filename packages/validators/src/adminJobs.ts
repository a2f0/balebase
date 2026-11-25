import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { cronExpressionMaxLength } from "./cron";
import { route } from "./route";

const AdminSnapshotSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});

/** A maintenance job's saved schedule: a five-field cron expression in UTC. */
const JobScheduleSchema = z.object({
  cron: z.string(),
  enabled: z.boolean(),
  /** The next minute it queues the job; null while paused. */
  nextRunAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The admin who last changed it as they were then; null for the default. */
  updatedBy: AdminSnapshotSchema.nullable(),
});
export type JobSchedule = z.infer<typeof JobScheduleSchema>;

const JobDefinitionSchema = z.object({
  description: z.string(),
  id: z.string(),
  name: z.string(),
  /**
   * A maintenance job: it can be run or dry-run from here and has a schedule
   * root admins edit. Bank sync is listed only for its history.
   */
  manual: z.boolean(),
  runSchedule: z.string(),
  /** Null for a job whose timing is not set here, such as bank sync. */
  schedule: JobScheduleSchema.nullable(),
});
export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const JobOutputSchema = z.record(
  z.string(),
  z.union([z.number(), z.boolean(), z.string()]),
);
export type JobOutput = z.infer<typeof JobOutputSchema>;
const JobRunSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  status: JobStatusSchema,
  source: z.enum(["manual", "scheduled", "daily"]),
  /** It reported what the job would change and changed nothing. */
  dryRun: z.boolean(),
  requestedBy: z.string().nullable(),
  /** The requester's name and email when they asked; null for older runs. */
  requestedByName: z.string().nullable(),
  requestedByEmail: z.string().nullable(),
  organizationId: z.string().nullable(),
  connectionId: z.string().nullable(),
  attempts: z.number(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  availableAt: z.string(),
  durationMs: z.number().nullable(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  output: JobOutputSchema.nullable(),
});
export type JobRun = z.infer<typeof JobRunSchema>;
export const JobLogDetailsSchema = z.record(z.string(), z.unknown());
const JobLogSchema = z.object({
  id: z.number(),
  occurredAt: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  details: JobLogDetailsSchema,
});

/** One manual maintenance request, kept after its run's history expires. */
const MaintenanceRequestSchema = z.object({
  /** The requester as they were when they asked. */
  actor: AdminSnapshotSchema,
  /** A dry run, which changes nothing. */
  dryRun: z.boolean(),
  id: z.string(),
  jobId: z.string(),
  /** The request joined a run that was already queued or running. */
  joinedActiveRun: z.boolean(),
  requestedAt: z.string(),
  runId: z.string(),
});
export type MaintenanceRequest = z.infer<typeof MaintenanceRequestSchema>;

/** One change to a job's schedule, kept after the admin's account is purged. */
const JobScheduleChangeSchema = z.object({
  actor: AdminSnapshotSchema,
  changedAt: z.string(),
  cron: z.string(),
  enabled: z.boolean(),
  id: z.string(),
  jobId: z.string(),
  /** Null when the job had no saved schedule before. */
  previousCron: z.string().nullable(),
  previousEnabled: z.boolean().nullable(),
});
export type JobScheduleChange = z.infer<typeof JobScheduleChangeSchema>;

export const adminJobsRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/jobs",
    response: z.object({ jobs: z.array(JobDefinitionSchema) }),
  }),
  start: route({
    method: "POST",
    path: "/api/admin/jobs/:jobId/runs",
    body: z.object({
      confirm: z.string(),
      /** Report what the job would change without changing anything. */
      dryRun: z.boolean().optional(),
    }),
    response: z.object({ run: JobRunSchema }),
  }),
  /** Replaces a maintenance job's schedule; the API validates the expression. */
  schedule: route({
    method: "PUT",
    path: "/api/admin/jobs/:jobId/schedule",
    body: z.object({
      cron: z.string().max(cronExpressionMaxLength),
      enabled: z.boolean(),
    }),
    response: z.object({ job: JobDefinitionSchema }),
  }),
  /** A job's schedule changes, newest first. */
  scheduleChanges: route({
    method: "GET",
    path: "/api/admin/jobs/:jobId/schedule/changes",
    query: z.object({ cursor: z.string().max(500).optional() }),
    response: z.object({
      changes: z.array(JobScheduleChangeSchema),
      nextCursor: z.string().nullable(),
    }),
  }),
  runs: route({
    method: "GET",
    path: "/api/admin/jobs/runs",
    query: z.object({
      jobId: z.string().max(100).optional(),
      status: JobStatusSchema.optional(),
      cursor: z.string().max(500).optional(),
    }),
    response: z.object({
      runs: z.array(JobRunSchema),
      nextCursor: z.string().nullable(),
    }),
  }),
  /** Purged accounts and organizations, newest first; kept after job history. */
  purges: route({
    method: "GET",
    path: "/api/admin/jobs/purges",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  requests: route({
    method: "GET",
    path: "/api/admin/jobs/requests",
    query: z.object({
      jobId: z.string().max(100).optional(),
      cursor: z.string().max(500).optional(),
    }),
    response: z.object({
      requests: z.array(MaintenanceRequestSchema),
      nextCursor: z.string().nullable(),
    }),
  }),
  detail: route({
    method: "GET",
    path: "/api/admin/jobs/runs/:runId",
    query: z.object({
      before: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional(),
    }),
    response: z.object({
      run: JobRunSchema,
      logs: z.array(JobLogSchema),
      nextBefore: z.string().nullable(),
    }),
  }),
};
