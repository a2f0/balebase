import { z } from "zod";
import { route } from "./route";

const JobDefinitionSchema = z.object({
  description: z.string(),
  id: z.string(),
  name: z.string(),
  manual: z.boolean(),
});
export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const JobOutputSchema = z.record(
  z.string(),
  z.union([z.number(), z.boolean(), z.string()]),
);
export type JobOutput = z.infer<typeof JobOutputSchema>;
const JobRunSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  status: JobStatusSchema,
  source: z.enum(["manual", "scheduled", "daily"]),
  requestedBy: z.string().nullable(),
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
const JobLogSchema = z.object({
  id: z.number(),
  occurredAt: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
});

export const adminJobsRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/jobs",
    query: z.object({ all: z.literal("true").optional() }),
    response: z.object({ jobs: z.array(JobDefinitionSchema) }),
  }),
  run: route({
    method: "POST",
    path: "/api/admin/jobs/:jobId/run",
    body: z.object({ confirm: z.string() }),
    response: z.object({
      run: z.object({
        runId: z.string(),
        jobId: z.string(),
        status: z.enum(["succeeded", "failed"]),
        startedAt: z.string(),
        finishedAt: z.string(),
        durationMs: z.number(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      }),
    }),
  }),
  start: route({
    method: "POST",
    path: "/api/admin/jobs/:jobId/runs",
    body: z.object({ confirm: z.string() }),
    response: z.object({ run: JobRunSchema }),
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
  detail: route({
    method: "GET",
    path: "/api/admin/jobs/runs/:runId",
    query: z.object({
      before: z
        .string()
        .regex(/^\d{1,16}$/)
        .optional(),
    }),
    response: z.object({
      run: JobRunSchema,
      logs: z.array(JobLogSchema),
      nextBefore: z.string().nullable(),
    }),
  }),
};
