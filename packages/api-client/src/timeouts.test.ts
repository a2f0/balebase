import { expect, it } from "bun:test";
import type { OfflineOperation } from "@balebase/validators/offline";
import { ApiClient } from "./ApiClient";

const scope = { organizationId: "org", userId: "user" };

/** Sends each call, keeping whether its request carried an abort signal. */
async function timedOut(calls: Record<string, (api: ApiClient) => unknown>) {
  const timed: Record<string, boolean> = {};
  let current = "";
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (_url, init) => {
      timed[current] = init.signal instanceof AbortSignal;
      return Response.json({});
    },
  });
  for (const [name, call] of Object.entries(calls)) {
    current = name;
    await call(api);
  }
  return timed;
}

it("bounds offline sync and job output reads, and nothing else", async () => {
  const operation = { type: "issue" } as OfflineOperation;
  const image = new File(["png"], "panel.png", { type: "image/png" });
  expect(
    await timedOut({
      apply: (api) => api.offline.apply(scope, operation),
      form: (api) => api.offline.form(scope, "form-1"),
      images: (api) => api.offline.images("issue-1"),
      jobOutput: (api) => api.adminJobs.detail("run-1"),
      jobRuns: (api) => api.adminJobs.runs(),
      me: (api) => api.session.me(),
      sync: (api) => api.offline.sync(scope),
      uploadImage: (api) =>
        api.offline.uploadImage(scope, "issue-1", "image-1", image),
    }),
  ).toEqual({
    apply: true,
    form: true,
    images: true,
    jobOutput: true,
    jobRuns: false,
    me: false,
    sync: true,
    uploadImage: true,
  });
});

it("keeps every area of the client under a caller's signal", async () => {
  const sent: { signal: AbortSignal | null | undefined; url: string }[] = [];
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (url, init) => {
      sent.push({ signal: init.signal, url });
      return Response.json({ user: null });
    },
  });
  const leaving = new AbortController();
  const scoped = api.withSignal(leaving.signal);
  expect(scoped).toBeInstanceOf(ApiClient);
  expect(scoped.withSignal(leaving.signal)).toBeInstanceOf(ApiClient);
  await scoped.session.me();
  await scoped.adminJobs.detail("run-1");
  await api.session.me();
  expect(sent.map(({ url }) => url)).toEqual([
    "https://api.test/api/me",
    "https://api.test/api/admin/jobs/runs/run-1",
    "https://api.test/api/me",
  ]);
  leaving.abort();
  expect(sent.map(({ signal }) => signal?.aborted)).toEqual([
    true,
    true,
    undefined,
  ]);
});
