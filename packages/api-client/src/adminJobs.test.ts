import { expect, it } from "bun:test";
import type { MaintenanceRun } from "@balebase/validators/adminJobs";
import { ApiClient } from "./ApiClient";

const run: MaintenanceRun = {
  durationMs: 12,
  error: "Bucket unavailable.",
  finishedAt: "2026-10-21T12:00:01.000Z",
  jobId: "purge",
  runId: "run-1",
  startedAt: "2026-10-21T12:00:00.000Z",
  status: "failed",
};

function client(reply: () => Response) {
  return new ApiClient({
    baseUrl: "https://api.test",
    fetch: async () => reply(),
  });
}

it("returns a failed run, whose 500 carries the run ID for its logs", async () => {
  const api = client(() => Response.json({ run }, { status: 500 }));
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
