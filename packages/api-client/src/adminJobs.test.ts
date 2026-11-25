import { expect, it } from "bun:test";
import type { JobRun } from "@balebase/validators/adminJobs";
import { ApiClient } from "./ApiClient";

const run: JobRun = {
  durationMs: null,
  error: null,
  errorCode: null,
  output: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  availableAt: "2026-10-21T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  jobId: "purge",
  runId: "run-1",
  status: "queued",
  source: "manual",
  dryRun: false,
  requestedBy: "actor",
  requestedByName: "Admin Actor",
  requestedByEmail: "actor@example.com",
  organizationId: null,
  connectionId: null,
  attempts: 0,
};

function client(reply: () => Response) {
  return new ApiClient({
    baseUrl: "https://api.test",
    fetch: async () => reply(),
  });
}

it("returns an accepted asynchronous run", async () => {
  const api = client(() => Response.json({ run }, { status: 202 }));
  expect(await api.adminJobs.run("purge")).toEqual(run);
});

it("throws when a run is refused before it starts", async () => {
  const api = client(() =>
    Response.json({ error: "Unknown maintenance job." }, { status: 404 }),
  );
  await expect(api.adminJobs.run("purge")).rejects.toThrow(
    "Unknown maintenance job.",
  );
});

it("passes history filters and log cursors through the typed client", async () => {
  const urls: string[] = [];
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (url) => {
      urls.push(url);
      return Response.json(
        url.includes("runs/run-1")
          ? { run, logs: [], nextBefore: null }
          : { runs: [run], nextCursor: null },
      );
    },
  });
  expect(
    (
      await api.adminJobs.runs({
        jobId: "purge",
        status: "queued",
        cursor: "next",
      })
    ).runs,
  ).toEqual([run]);
  expect((await api.adminJobs.detail("run-1", "123")).run).toEqual(run);
  expect(urls).toEqual([
    "https://api.test/api/admin/jobs/runs?jobId=purge&status=queued&cursor=next",
    "https://api.test/api/admin/jobs/runs/run-1?before=123",
  ]);
});

it("requests the job catalog", async () => {
  let requested = "";
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (url) => {
      requested = url;
      return Response.json({ jobs: [] });
    },
  });
  expect(await api.adminJobs.list()).toEqual([]);
  expect(requested).toBe("https://api.test/api/admin/jobs");
});

it("sends dry runs and schedule changes to their routes", async () => {
  const requests: { body: unknown; method: string; url: string }[] = [];
  const job = {
    description: "Purges.",
    id: "purge",
    manual: true,
    name: "Purge",
    runSchedule: "Every day at 03:00 UTC.",
    schedule: {
      cron: "0 3 * * *",
      enabled: true,
      nextRunAt: "2026-10-22T03:00:00.000Z",
      updatedAt: "2026-10-21T12:00:00.000Z",
      updatedBy: null,
    },
  };
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (url, init) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method ?? "GET",
        url,
      });
      if (url.endsWith("/runs"))
        return Response.json(
          { run: { ...run, dryRun: true } },
          { status: 202 },
        );
      if (url.includes("/changes"))
        return Response.json({ changes: [], nextCursor: null });
      return Response.json({ job });
    },
  });
  expect((await api.adminJobs.run("purge", { dryRun: true })).dryRun).toBe(
    true,
  );
  expect(
    await api.adminJobs.saveSchedule("purge", {
      cron: "0 3 * * *",
      enabled: true,
    }),
  ).toEqual(job);
  await api.adminJobs.scheduleChanges("purge", "next");
  expect(requests).toEqual([
    {
      body: { confirm: "purge", dryRun: true },
      method: "POST",
      url: "https://api.test/api/admin/jobs/purge/runs",
    },
    {
      body: { cron: "0 3 * * *", enabled: true },
      method: "PUT",
      url: "https://api.test/api/admin/jobs/purge/schedule",
    },
    {
      body: undefined,
      method: "GET",
      url: "https://api.test/api/admin/jobs/purge/schedule/changes?cursor=next",
    },
  ]);
});
