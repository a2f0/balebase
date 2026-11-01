import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { createRoot } from "react-dom/client";
import { AdminJobs } from "../src/admin/AdminJobs";

const jobs: JobDefinition[] = [
  {
    id: "purgeRequestedUsers",
    name: "Purge requested user accounts",
    description:
      "Permanently deletes accounts requested for deletion at least 30 days ago. Skips admins, active organization members, and accounts required by retained audit, financial, or contract records.",
    manual: true,
    runSchedule:
      "Every hour at 17 minutes past the hour (UTC) in production. Manual only in staging.",
  },
  {
    id: "purgeDeletedObjects",
    name: "Purge deleted files",
    description:
      "Deletes a batch of queued files from storage after their upload grace period.",
    manual: true,
    runSchedule:
      "Every hour at 17 minutes past the hour (UTC) in production. Manual only in staging.",
  },
];
const run: JobRun = {
  runId: "scheduled:purgeRequestedUsers:1793035020000",
  jobId: "purgeRequestedUsers",
  status: "succeeded",
  source: "scheduled",
  requestedBy: null,
  requestedByName: null,
  requestedByEmail: null,
  organizationId: null,
  connectionId: null,
  attempts: 1,
  createdAt: "2026-10-26T18:17:00.000Z",
  startedAt: "2026-10-26T18:17:01.000Z",
  finishedAt: "2026-10-26T18:17:02.000Z",
  availableAt: "2026-10-26T18:17:00.000Z",
  durationMs: 1000,
  errorCode: null,
  error: null,
  output: { purged: 0, blocked: 1 },
};

export function mount(element: HTMLElement) {
  const fetchJobs = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/jobs")) return Response.json({ jobs });
    if (url.pathname.endsWith("/purges"))
      return Response.json({ events: [], nextCursor: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({
        runs: [
          run,
          { ...run, runId: "second-run", jobId: "purgeDeletedObjects" },
        ],
        nextCursor: null,
      });
    return Response.json({
      run,
      logs: [
        {
          id: 1,
          occurredAt: run.finishedAt,
          level: "info",
          message: "Job completed.",
          details: { status: run.status, output: run.output },
        },
      ],
      nextBefore: null,
    });
  };
  window.fetch = Object.assign(fetchJobs, { preconnect: () => {} });
  createRoot(element).render(<AdminJobs />);
}
