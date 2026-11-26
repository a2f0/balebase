import type { adminJobsRoutes } from "@balebase/validators/adminJobs";
import type { RouteInput } from "@balebase/validators/route";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminJobsRoutes.list>({
    method: "GET",
    path: "/api/admin/jobs",
    response: "json",
  }),
  run: endpoint<typeof adminJobsRoutes.start>({
    method: "POST",
    path: "/api/admin/jobs/:jobId/runs",
    body: "json",
    response: "json",
  }),
  schedule: endpoint<typeof adminJobsRoutes.schedule>({
    method: "PUT",
    path: "/api/admin/jobs/:jobId/schedule",
    body: "json",
    response: "json",
  }),
  scheduleChanges: endpoint<typeof adminJobsRoutes.scheduleChanges>({
    method: "GET",
    path: "/api/admin/jobs/:jobId/schedule/changes",
    response: "json",
  }),
  runs: endpoint<typeof adminJobsRoutes.runs>({
    method: "GET",
    path: "/api/admin/jobs/runs",
    response: "json",
  }),
  purges: endpoint<typeof adminJobsRoutes.purges>({
    method: "GET",
    path: "/api/admin/jobs/purges",
    response: "json",
  }),
  requests: endpoint<typeof adminJobsRoutes.requests>({
    method: "GET",
    path: "/api/admin/jobs/requests",
    response: "json",
  }),
  detail: endpoint<typeof adminJobsRoutes.detail>({
    method: "GET",
    path: "/api/admin/jobs/runs/:runId",
    response: "json",
    // Bounds a slow output read so the run page can offer a retry.
    timeoutMs: 30_000,
  }),
};

export function adminJobsApi(transport: Transport) {
  return {
    async list() {
      return (await transport.call(endpoints.list, {})).jobs;
    },
    /** Queues the job; a dry run reports what it would change instead. */
    async run(jobId: string, options: { dryRun?: boolean } = {}) {
      return (
        await transport.call(endpoints.run, {
          body: options.dryRun
            ? { confirm: jobId, dryRun: true }
            : { confirm: jobId },
          params: { jobId },
        })
      ).run;
    },
    /** Saves a maintenance job's cron schedule (UTC) and returns the job. */
    async saveSchedule(
      jobId: string,
      schedule: RouteInput<typeof adminJobsRoutes.schedule>["body"],
    ) {
      return (
        await transport.call(endpoints.schedule, {
          body: schedule,
          params: { jobId },
        })
      ).job;
    },
    /** A job's schedule changes, newest first. */
    scheduleChanges(jobId: string, cursor?: string) {
      return transport.call(endpoints.scheduleChanges, {
        params: { jobId },
        query: cursor ? { cursor } : {},
      });
    },
    runs(query: RouteInput<typeof adminJobsRoutes.runs>["query"] = {}) {
      return transport.call(endpoints.runs, { query });
    },
    /** The purge history of accounts and organizations, newest first. */
    purges(cursor?: string) {
      return transport.call(endpoints.purges, { query: { cursor } });
    },
    /** Manual maintenance requests, newest first. */
    requests(query: RouteInput<typeof adminJobsRoutes.requests>["query"] = {}) {
      return transport.call(endpoints.requests, { query });
    },
    detail(runId: string, before?: string) {
      return transport.call(endpoints.detail, {
        params: { runId },
        query: before ? { before } : {},
      });
    },
  };
}
