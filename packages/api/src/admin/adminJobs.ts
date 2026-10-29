import { adminJobsRoutes } from "@balebase/validators/adminJobs";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/authMiddleware";
import { jobRunDetail, listJobRuns } from "../jobs/jobHistory";
import { toJobRun } from "../jobs/jobRuns";
import { waitForLegacyJob } from "../jobs/legacyJobRun";
import { enqueueMaintenance, maintenanceJobs } from "../jobs/maintenance";
import { readBody, readQuery, respond } from "../shared/respond";

const adminJobs = new Hono<ApiEnv>();
adminJobs.get("/", (context) =>
  respond(context, adminJobsRoutes.list, {
    jobs: [
      ...maintenanceJobs.map((job) => ({
        ...job,
        manual: true,
        runSchedule:
          "Every hour at 17 minutes past the hour (UTC) in production. Manual only in staging.",
      })),
      ...(context.req.query("all") === "true"
        ? [
            {
              id: "syncFinanceConnection",
              name: "Sync bank accounts",
              manual: false,
              runSchedule:
                "Once per UTC day for connections with daily sync enabled; checked every 5 minutes from 00:00 UTC. Manual sync from Finance.",
              description:
                "Imports bank transactions. Start a sync from Finance or enable daily sync on a connection.",
            },
          ]
        : []),
    ],
  }),
);
adminJobs.get("/runs", async (context) => {
  const query = readQuery(
    context,
    adminJobsRoutes.runs,
    "Invalid history filter.",
  );
  if (query instanceof Response) return query;
  const history = await listJobRuns(context.env.DB, query);
  if (!history) return context.json({ error: "Invalid history cursor." }, 400);
  return respond(context, adminJobsRoutes.runs, history);
});
adminJobs.get("/runs/:runId", async (context) => {
  const query = readQuery(
    context,
    adminJobsRoutes.detail,
    "Invalid log cursor.",
  );
  if (query instanceof Response) return query;
  const detail = await jobRunDetail(
    context.env.DB,
    context.req.param("runId"),
    query.before,
  );
  if (!detail) return context.json({ error: "Job run not found." }, 404);
  return respond(context, adminJobsRoutes.detail, detail);
});
adminJobs.post("/:jobId/run", (context) => startMaintenance(context, true));
adminJobs.post("/:jobId/runs", (context) => startMaintenance(context, false));

async function startMaintenance(context: Context<ApiEnv>, legacy: boolean) {
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  const job = maintenanceJobs.find(
    ({ id }) => id === context.req.param("jobId"),
  );
  if (!job) return context.json({ error: "Unknown maintenance job." }, 404);
  const confirmation = "Confirm the job ID to run this job.";
  const input = await readBody(
    context,
    legacy ? adminJobsRoutes.run : adminJobsRoutes.start,
    confirmation,
  );
  if (input instanceof Response) return input;
  if (input.confirm !== job.id) {
    return context.json({ error: confirmation }, 400);
  }
  if (!context.env.FINANCE_SYNC_QUEUE)
    return context.json({ error: "Background jobs are not configured." }, 503);
  const run = await enqueueMaintenance(context.env, job.id, {
    trigger: "manual",
    actorUserId: context.get("authSession").user.id,
  });
  if (!legacy)
    return respond(context, adminJobsRoutes.start, { run: toJobRun(run) }, 202);
  const completed = await waitForLegacyJob(context.env.DB, run.id);
  if (!completed)
    return context.json(
      {
        error:
          "Maintenance continues in the background. Update or reopen Jobs to check its status before retrying.",
      },
      503,
    );
  return respond(
    context,
    adminJobsRoutes.run,
    { run: completed },
    completed.status === "failed" ? 500 : 200,
  );
}

export { adminJobs };
