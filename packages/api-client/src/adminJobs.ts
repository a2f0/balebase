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
  }),
};

export function adminJobsApi(transport: Transport) {
  return {
    async list() {
      return (await transport.call(endpoints.list, { query: { all: "true" } }))
        .jobs;
    },
    async run(jobId: string) {
      return (
        await transport.call(endpoints.run, {
          body: { confirm: jobId },
          params: { jobId },
        })
      ).run;
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
