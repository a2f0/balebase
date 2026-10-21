import { adminJobsRoutes } from "@balebase/validators/adminJobs";
import { Hono } from "hono";
import { type AuthVariables, requireRole } from "./authMiddleware";
import {
  maintenanceJobs,
  maintenanceTasks,
  runMaintenanceJob,
} from "./maintenance";
import { respond } from "./respond";
import type { Bindings } from "./types";

const adminJobs = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
adminJobs.use("*", requireRole("admin"));
adminJobs.get("/", (context) =>
  respond(context, adminJobsRoutes.list, { jobs: [...maintenanceJobs] }),
);
adminJobs.post("/:jobId/run", async (context) => {
  // CORS alone does not prevent cross-origin form submissions with cookies.
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  const job = maintenanceJobs.find(
    ({ id }) => id === context.req.param("jobId"),
  );
  if (!job) return context.json({ error: "Unknown maintenance job." }, 404);
  const input = await context.req
    .json<{ confirm?: unknown }>()
    .catch(() => null);
  if (input?.confirm !== job.id) {
    return context.json({ error: "Confirm the job ID to run this job." }, 400);
  }
  const run = runMaintenanceJob(job.id, maintenanceTasks(context.env)[job.id], {
    trigger: "manual",
    actorUserId: context.get("authSession").user.id,
  });
  context.executionCtx.waitUntil(run);
  const result = await run;
  return respond(
    context,
    adminJobsRoutes.run,
    { run: result },
    result.status === "failed" ? 500 : 200,
  );
});

export { adminJobs };
