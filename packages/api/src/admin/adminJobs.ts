import { adminJobsRoutes } from "@balebase/validators/adminJobs";
import { cronProblem, normalizeCron } from "@balebase/validators/cron";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { jobRunDetail, listJobRuns } from "../jobs/jobHistory";
import { toJobRun } from "../jobs/jobRuns";
import {
  describeJobSchedule,
  listJobScheduleChanges,
  readJobSchedules,
  saveJobSchedule,
  toJobSchedule,
} from "../jobs/jobSchedules";
import {
  enqueueMaintenance,
  isMaintenanceJobId,
  type MaintenanceJobId,
  maintenanceJobs,
} from "../jobs/maintenance";
import { findPlatformActivity } from "../shared/activity";
import { readBody, readQuery, respond } from "../shared/respond";
import { listMaintenanceRequests } from "./platformHistory";

const purgeActions = ["user.purged", "organization.purged"] as const;

/** Every job root admins see, maintenance with its saved schedule. */
async function jobDefinitions(database: D1Database) {
  const schedules = await readJobSchedules(database);
  const now = new Date();
  return [
    ...maintenanceJobs.map((job) => {
      const schedule = toJobSchedule(schedules.get(job.id), now);
      return {
        description: job.description,
        id: job.id,
        name: job.name,
        manual: true,
        runSchedule: describeJobSchedule(schedule),
        schedule,
      };
    }),
    {
      id: "syncFinanceConnection",
      name: "Sync bank accounts",
      manual: false,
      runSchedule:
        "Once per UTC day for connections with daily sync enabled; checked every 5 minutes from 00:00 UTC. Manual sync from Finance.",
      schedule: null,
      description:
        "Imports bank transactions. Start a sync from Finance or enable daily sync on a connection.",
    },
  ];
}

const adminJobs = new Hono<ApiEnv>();
adminJobs.get("/", async (context) =>
  respond(context, adminJobsRoutes.list, {
    jobs: await jobDefinitions(context.env.DB),
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
/** Purge records outlive both the purged records and the 30-day job history. */
adminJobs.get("/purges", async (context) => {
  // Like account management, it names who asked for each deletion.
  if (context.get("authSession").session.impersonatedBy) {
    return context.json({ error: "Insufficient permissions." }, 403);
  }
  const query = readQuery(
    context,
    adminJobsRoutes.purges,
    "Invalid activity cursor.",
  );
  if (query instanceof Response) return query;
  const page = await findPlatformActivity(
    context.env.DB,
    purgeActions,
    query.cursor,
  );
  return page
    ? respond(context, adminJobsRoutes.purges, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});
adminJobs.get("/requests", async (context) => {
  if (context.get("authSession").session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot read maintenance requests." },
      403,
    );
  }
  const query = readQuery(
    context,
    adminJobsRoutes.requests,
    "Invalid request filter.",
  );
  if (query instanceof Response) return query;
  const requests = await listMaintenanceRequests(context.env.DB, query);
  if (!requests) return context.json({ error: "Invalid history cursor." }, 400);
  return respond(context, adminJobsRoutes.requests, requests);
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
adminJobs.post("/:jobId/runs", async (context) => {
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  const jobId = context.req.param("jobId");
  if (!isMaintenanceJobId(jobId))
    return context.json({ error: "Unknown maintenance job." }, 404);
  const confirmation = "Confirm the job ID to run this job.";
  const input = await readBody(context, adminJobsRoutes.start, confirmation);
  if (input instanceof Response) return input;
  if (input.confirm !== jobId) {
    return context.json({ error: confirmation }, 400);
  }
  if (!context.env.FINANCE_SYNC_QUEUE)
    return context.json({ error: "Background jobs are not configured." }, 503);
  const run = await enqueueMaintenance(context.env, jobId, {
    trigger: "manual",
    actorUserId: context.get("authSession").user.id,
    dryRun: input.dryRun === true,
  });
  if (!run)
    return context.json({ error: "Only root admins can run jobs." }, 403);
  return respond(context, adminJobsRoutes.start, { run: toJobRun(run) }, 202);
});
adminJobs.put("/:jobId/schedule", async (context) => {
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  // A change records the admin who made it, never one acting as someone else.
  if (context.get("authSession").session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot change job schedules." },
      403,
    );
  }
  const jobId = context.req.param("jobId");
  if (!isMaintenanceJobId(jobId))
    return context.json({ error: "Unknown maintenance job." }, 404);
  const input = await readBody(
    context,
    adminJobsRoutes.schedule,
    "Enter a cron schedule and whether it is enabled.",
  );
  if (input instanceof Response) return input;
  const cron = normalizeCron(input.cron);
  const problem = cronProblem(cron);
  if (problem) return context.json({ error: problem }, 400);
  const saved = await saveJobSchedule(context.env.DB, {
    actorUserId: context.get("authSession").user.id,
    cron,
    enabled: input.enabled,
    jobId,
  });
  if (saved === "refused")
    return context.json(
      { error: "Only root admins can change job schedules." },
      403,
    );
  if (saved === "saved")
    console.log({
      event: "job_schedule_saved",
      jobId,
      cron,
      enabled: input.enabled,
    });
  return respond(context, adminJobsRoutes.schedule, {
    job: await jobDefinition(context.env.DB, jobId),
  });
});
adminJobs.get("/:jobId/schedule/changes", async (context) => {
  // Like manual requests, it names the admin behind each change.
  if (context.get("authSession").session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot read schedule changes." },
      403,
    );
  }
  const jobId = context.req.param("jobId");
  if (!isMaintenanceJobId(jobId))
    return context.json({ error: "Unknown maintenance job." }, 404);
  const query = readQuery(
    context,
    adminJobsRoutes.scheduleChanges,
    "Invalid history cursor.",
  );
  if (query instanceof Response) return query;
  const page = await listJobScheduleChanges(
    context.env.DB,
    jobId,
    query.cursor,
  );
  if (!page) return context.json({ error: "Invalid history cursor." }, 400);
  return respond(context, adminJobsRoutes.scheduleChanges, page);
});

async function jobDefinition(database: D1Database, jobId: MaintenanceJobId) {
  const job = (await jobDefinitions(database)).find(({ id }) => id === jobId);
  if (!job) throw new Error(`Missing job definition for ${jobId}.`);
  return job;
}

export { adminJobs };
