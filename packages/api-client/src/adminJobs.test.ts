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
  requestedBy: "actor",
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
