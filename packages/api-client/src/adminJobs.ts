import type {
  adminJobsRoutes,
  MaintenanceRun,
} from "@balebase/validators/adminJobs";
import { ApiError } from "./ApiError";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminJobsRoutes.list>({
    method: "GET",
    path: "/api/admin/jobs",
    response: "json",
  }),
  run: endpoint<typeof adminJobsRoutes.run>({
    method: "POST",
    path: "/api/admin/jobs/:jobId/run",
    body: "json",
    response: "json",
  }),
};

export function adminJobsApi(transport: Transport) {
  return {
    async list() {
      const body = await transport.call(endpoints.list);
      return body.jobs;
    },
    /**
     * Runs a job now, as the scheduled run would. A failed run answers 500
     * with the run itself, which carries the error and the run ID for its logs.
     */
    async run(jobId: string) {
      try {
        const body = await transport.call(endpoints.run, {
          body: { confirm: jobId },
          params: { jobId },
        });
        return body.run;
      } catch (cause) {
        const run = cause instanceof ApiError && failedRun(cause.data);
        if (run) return run;
        throw cause;
      }
    },
  };
}

function failedRun(data: unknown) {
  const run =
    typeof data === "object" && data !== null && "run" in data
      ? data.run
      : undefined;
  return typeof run === "object" && run !== null && "runId" in run
    ? (run as MaintenanceRun)
    : undefined;
}
