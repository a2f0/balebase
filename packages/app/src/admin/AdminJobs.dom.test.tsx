import { afterEach, expect, it, spyOn } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { act } from "react";
import { holdTimers, installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { runPollMs } from "./AdminJobRun";
import { AdminJobs } from "./AdminJobs";
import { historyPollMs } from "./useJobHistory";

const { button, mount, respond } = installDom({
  url: "http://localhost:5173/root/jobs",
  globals: () => ({
    IntersectionObserver: IntersectionObserverFixture,
  }),
});
let container: HTMLElement;

afterEach(() => {
  IntersectionObserverFixture.instances.length = 0;
});

const queued: JobRun = {
  runId: "run-1",
  jobId: "purgeRequestedUsers",
  status: "queued",
  source: "manual",
  requestedBy: "actor",
  requestedByName: "Admin Actor",
  requestedByEmail: "actor@example.com",
  organizationId: null,
  connectionId: null,
  attempts: 0,
  createdAt: "2026-10-26T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  availableAt: "2026-10-26T12:00:00.000Z",
  durationMs: null,
  error: null,
  errorCode: null,
  output: null,
};
const definitions: JobDefinition[] = [
  {
    id: "purgeRequestedUsers",
    name: "Purge requested user accounts",
    description: "Purges eligible accounts.",
    manual: true,
    runSchedule:
      "Every hour at 17 minutes past the hour (UTC) in production. Manual only in staging.",
  },
  {
    id: "syncFinanceConnection",
    name: "Sync bank accounts",
    description: "Start sync from Finance.",
    manual: false,
    runSchedule:
      "Once per UTC day for connections with daily sync enabled; checked every 5 minutes from 00:00 UTC. Manual sync from Finance.",
  },
];

it("times out a slow job output read and lets the user retry", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  const deadline = new AbortController();
  timeout.mockReturnValue(deadline.signal);
  let detailRequests = 0;
  respond(async (url, init) => {
    if (url.pathname.endsWith("/runs/run-1")) {
      detailRequests += 1;
      if (detailRequests === 1)
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      return Response.json({
        run: { ...queued, status: "succeeded", output: { recovered: true } },
        logs: [],
        nextBefore: null,
      });
    }
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [queued], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  try {
    await render();
    await act(async () => button("View run").click());
    expect(container.textContent).toContain("Loading job output…");
    expect(timeout).toHaveBeenCalledWith(30_000);
    await act(async () =>
      deadline.abort(new DOMException("Slow response", "TimeoutError")),
    );
    expect(container.textContent).toContain(
      "Loading job output took too long. Try again.",
    );
    expect(container.textContent).not.toContain("Loading job output…");
    timeout.mockReturnValue(new AbortController().signal);
    await act(async () => button("Retry loading output").click());
    expect(container.textContent).toContain('"recovered": true');
    expect(container.textContent).toContain(
      "Requested by: Admin Actor (actor@example.com)",
    );
    expect(detailRequests).toBe(2);
  } finally {
    timeout.mockRestore();
  }
});

it("keeps saved job output visible while retrying a failed poll", async () => {
  using polls = holdTimers(runPollMs);
  let detailRequests = 0;
  let finishRetry: ((response: Response) => void) | undefined;
  const response = (progress: number) =>
    Response.json({
      run: { ...queued, status: "running", output: { progress } },
      logs: [],
      nextBefore: null,
    });
  respond(async (url) => {
    if (url.pathname.endsWith("/runs/run-1")) {
      detailRequests += 1;
      if (detailRequests === 1) return response(1);
      if (detailRequests === 2) throw new Error("Connection interrupted");
      return new Promise<Response>((resolve) => {
        finishRetry = resolve;
      });
    }
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [queued], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  await act(async () => button("View run").click());
  expect(container.textContent).toContain('"progress": 1');
  await polls.fire();
  expect(container.textContent).toContain("Connection interrupted");
  await act(async () => button("Retry loading output").click());
  expect(container.textContent).toContain('"progress": 1');
  expect(container.textContent).not.toContain("Loading job output…");
  await act(async () => finishRetry?.(response(2)));
  expect(container.textContent).toContain('"progress": 2');
});

async function render() {
  const view = await mount(
    <>
      <AdminJobs />
      <DialogHost />
    </>,
  );
  container = view.container;
  return view;
}

it("queues confirmed maintenance, exposes persisted output after remount, and filters bank jobs", async () => {
  let completed = false;
  const requests: string[] = [];
  respond(async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const run = completed
      ? {
          ...queued,
          status: "succeeded",
          attempts: 1,
          output: { purged: 3, blocked: 1 },
        }
      : queued;
    if (url.pathname.endsWith("/purgeRequestedUsers/runs")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        confirm: "purgeRequestedUsers",
      });
      return Response.json({ run }, { status: 202 });
    }
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({
        run,
        logs: [
          {
            id: 1,
            occurredAt: queued.createdAt,
            level: "info",
            message: "Job queued.",
            details: { source: "manual" },
          },
        ],
        nextBefore: null,
      });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [run], nextCursor: null });
    if (url.pathname.endsWith("/jobs"))
      return Response.json({ jobs: definitions });
    throw new Error(`Unexpected URL ${url}`);
  });
  const first = await render();
  expect(container.textContent).toContain("30 days");
  expect(container.textContent).toContain("Sync bank accounts");
  const jobRows = [...container.querySelectorAll(".adminJobRow")];
  for (const job of definitions) {
    const row = jobRows.find((item) => item.textContent?.includes(job.name));
    expect(row?.textContent).toContain(`Run schedule: ${job.runSchedule}`);
  }
  expect(
    [...container.querySelectorAll("button")].filter(
      (item) => item.textContent === "Run now",
    ),
  ).toHaveLength(1);
  await act(async () => button("Run now").click());
  expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(
    0,
  );
  await act(async () => button("Run job").click());
  expect(container.textContent).toContain("Run ID: run-1");
  expect(container.textContent).not.toContain("Loading run history");
  expect(container.textContent).toContain("Job queued.");
  expect(container.textContent).not.toContain("Job completed.");
  completed = true;
  await first.unmount();
  container.remove();
  await render();
  await act(async () => button("View run").click());
  expect(container.textContent).toContain('"purged": 3');
  expect(container.textContent).toContain("succeeded");
  const disclosure = button("Hide run");
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  const panel = document.getElementById(
    disclosure.getAttribute("aria-controls") ?? "",
  );
  expect(panel?.parentElement).toBe(disclosure.closest(".adminJobHistoryItem"));
  expect(panel?.textContent).toContain('"purged": 3');
  await act(async () => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("Run ID: run-1");
  await act(async () => button("View run").click());
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing job filter");
  await act(async () => {
    select.value = "syncFinanceConnection";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(requests).toContain(
    "GET /api/admin/jobs/runs?jobId=syncFinanceConnection",
  );
  expect(container.textContent).not.toContain("Run ID: run-1");
});

it("shows failed saved runs and guards against a stale detail response", async () => {
  let finishFirst: ((response: Response) => void) | undefined;
  const failed: JobRun = {
    ...queued,
    runId: "run-2",
    status: "failed",
    errorCode: "INTERRUPTED",
    error: "Review completed work before retrying.",
  };
  respond(async (url) => {
    if (url.pathname.endsWith("/runs/run-1"))
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    if (url.pathname.endsWith("/runs/run-2"))
      return Response.json({ run: failed, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [queued, failed], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  const views = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "View run",
  );
  await act(async () => views[0]?.click());
  await act(async () => views[1]?.click());
  expect(views[0]?.getAttribute("aria-expanded")).toBe("false");
  expect(views[1]?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("INTERRUPTED");
  await act(async () =>
    finishFirst?.(Response.json({ run: queued, logs: [], nextBefore: null })),
  );
  expect(container.textContent).toContain("Run ID: run-2");
  expect(container.textContent).not.toContain("Run ID: run-1");
});

it("opens a requested run inline immediately and resets older filtered history", async () => {
  const requests: string[] = [];
  respond(async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (init?.method === "POST")
      return Response.json({ run: queued }, { status: 202 });
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({ run: queued, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs"))
      // History has not yet included the new run; the POST response supplies its row.
      return Response.json({
        runs: [],
        nextCursor: url.searchParams.has("cursor") ? null : "older",
      });
    return Response.json({ jobs: definitions });
  });
  await render();
  const filter = container.querySelector("select");
  if (!filter) throw new Error("Missing job filter");
  await act(async () => {
    filter.value = "syncFinanceConnection";
    filter.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => button("Older runs").click());
  expect(requests).toContain(
    "GET /api/admin/jobs/runs?jobId=syncFinanceConnection&cursor=older",
  );
  await act(async () => button("Run now").click());
  await act(async () => button("Run job").click());
  expect(container.querySelector("select")?.value).toBe("");
  expect(
    button("Hide run").closest(".adminJobHistoryItem")?.textContent,
  ).toContain("Run ID: run-1");
  expect(container.textContent).not.toContain("No runs match");
  // Reusing the same active job must reopen its inline details after a collapse.
  await act(async () => button("Hide run").click());
  await act(async () => button("Run now").click());
  await act(async () => button("Run job").click());
  expect(button("Hide run").getAttribute("aria-expanded")).toBe("true");
});

it("does not restore a requested run after history has shown it and newer runs replace it", async () => {
  let historyRuns = [queued];
  respond(async (url, init) => {
    if (init?.method === "POST")
      return Response.json({ run: queued }, { status: 202 });
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({ run: queued, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: historyRuns, nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  await act(async () => button("Run now").click());
  await act(async () => button("Run job").click());
  expect(container.textContent).toContain("Run ID: run-1");
  historyRuns = [{ ...queued, runId: "newer-run", status: "succeeded" }];
  const filter = container.querySelector("select");
  if (!filter) throw new Error("Missing job filter");
  for (const value of ["purgeRequestedUsers", ""]) {
    await act(async () => {
      filter.value = value;
      filter.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }
  expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(1);
  expect(
    container.querySelector(".adminJobHistoryItem")?.textContent,
  ).toContain("succeeded");
  expect(container.textContent).not.toContain("queued · manual");
});

it("loads older runs on intersection once, deduplicates overlaps, and preserves expanded details", async () => {
  const older = Promise.withResolvers<Response>();
  let olderRequests = 0;
  respond(async (url) => {
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({ run: queued, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs")) {
      if (url.searchParams.has("cursor")) {
        olderRequests++;
        return older.promise;
      }
      return Response.json({ runs: [queued], nextCursor: "older" });
    }
    return Response.json({ jobs: definitions });
  });
  await render();
  await act(async () => button("View run").click());
  const firstRow = container.querySelector(".adminJobHistoryItem");
  await act(async () => {
    IntersectionObserverFixture.intersect();
    IntersectionObserverFixture.intersect();
    button("Older runs").click();
  });
  expect(olderRequests).toBe(1);
  expect(container.textContent).toContain("Run ID: run-1");
  await act(async () =>
    older.resolve(
      Response.json({
        runs: [queued, { ...queued, runId: "older-run", status: "succeeded" }],
        nextCursor: null,
      }),
    ),
  );
  expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(2);
  expect(container.querySelector(".adminJobHistoryItem")).toBe(firstRow);
  expect(button("Hide run").getAttribute("aria-expanded")).toBe("true");
  await act(async () => IntersectionObserverFixture.intersect());
  expect(olderRequests).toBe(1);
});

it("discards old pages and observer notifications after job and status filters change", async () => {
  const older = Promise.withResolvers<Response>();
  const queries: string[] = [];
  respond(async (url) => {
    if (!url.pathname.endsWith("/runs"))
      return Response.json({ jobs: definitions });
    queries.push(url.search);
    if (url.searchParams.has("cursor")) return older.promise;
    return Response.json({
      runs: [
        {
          ...queued,
          runId: url.searchParams.has("status") ? "filtered" : "initial",
        },
      ],
      nextCursor: url.search ? null : "older",
    });
  });
  await render();
  const oldObserver = IntersectionObserverFixture.instances.at(-1);
  await act(async () => IntersectionObserverFixture.intersect());
  const selects = container.querySelectorAll("select");
  for (const [index, value] of [
    [0, "syncFinanceConnection"],
    [1, "failed"],
  ] as const) {
    await act(async () => {
      const select = selects[index];
      if (!select) throw new Error("Missing filter");
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }
  expect(queries.at(-1)).toBe("?jobId=syncFinanceConnection&status=failed");
  await act(async () =>
    older.resolve(
      Response.json({
        runs: [{ ...queued, runId: "stale" }],
        nextCursor: "stale-cursor",
      }),
    ),
  );
  await act(async () => oldObserver?.notify());
  expect(queries).toHaveLength(4);
  expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(1);
  expect(container.textContent).not.toContain("Older runs");
});

it("pauses automatic history paging on failure and retries the same cursor manually", async () => {
  const cursors: string[] = [];
  respond(async (url) => {
    if (!url.pathname.endsWith("/runs"))
      return Response.json({ jobs: definitions });
    const cursor = url.searchParams.get("cursor");
    if (!cursor) return Response.json({ runs: [queued], nextCursor: "older" });
    cursors.push(cursor);
    if (cursors.length === 1)
      return Response.json({ error: "History unavailable." }, { status: 503 });
    return Response.json({
      runs: [{ ...queued, runId: "older-run" }],
      nextCursor: null,
    });
  });
  await render();
  await act(async () => IntersectionObserverFixture.intersect());
  expect(container.textContent).toContain("History unavailable.");
  expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(1);
  await act(async () => IntersectionObserverFixture.intersect());
  expect(cursors).toEqual(["older"]);
  await act(async () => button("Retry loading older runs").click());
  expect(cursors).toEqual(["older", "older"]);
  expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(2);
  expect(container.textContent).not.toContain("History unavailable.");
});

it("retries automatic loading when a poll wins the race to load history", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  let firstPages = 0;
  let olderPages = 0;
  let finishPoll: ((response: Response) => void) | undefined;
  const firstPage = () =>
    Response.json({ runs: [queued], nextCursor: "older" });
  respond(async (url) => {
    if (!url.pathname.endsWith("/runs"))
      return Response.json({ jobs: definitions });
    if (url.searchParams.has("cursor")) {
      olderPages++;
      return Response.json({
        runs: [{ ...queued, runId: "old" }],
        nextCursor: null,
      });
    }
    if (++firstPages === 1) return firstPage();
    return new Promise<Response>((resolve) => {
      finishPoll = resolve;
    });
  });
  try {
    await render();
    const poll = timer.mock.calls.findLast(
      ([, delay]) => delay === historyPollMs,
    )?.[0];
    if (typeof poll !== "function") throw new Error("Missing history refresh");
    await act(async () => {
      poll();
      // The observer still has the render before the poll published its busy state.
      IntersectionObserverFixture.intersect();
    });
    expect(olderPages).toBe(0);
    await act(async () => finishPoll?.(firstPage()));
    await act(async () => IntersectionObserverFixture.intersect());
    expect(olderPages).toBe(1);
    expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(2);
  } finally {
    timer.mockRestore();
  }
});

it("refreshes through the oldest loaded run when new jobs shift page boundaries", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  let refreshed = false;
  const history = (ids: string[], nextCursor: string | null) =>
    Response.json({
      runs: ids.map((runId) => ({ ...queued, runId, status: "succeeded" })),
      nextCursor,
    });
  respond(async (url) => {
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({
        run: { ...queued, status: "succeeded" },
        logs: [],
        nextBefore: null,
      });
    if (!url.pathname.endsWith("/runs"))
      return Response.json({ jobs: definitions });
    const cursor = url.searchParams.get("cursor");
    if (cursor === "page-2") return history(["run-1"], null);
    if (cursor === "new-2") return history(["run-2"], "new-3");
    if (cursor === "new-3") return history(["run-1"], null);
    return refreshed
      ? history(["run-4", "run-3"], "new-2")
      : history(["run-3", "run-2"], "page-2");
  });
  try {
    await render();
    await act(async () => IntersectionObserverFixture.intersect());
    const oldest = container.querySelectorAll(".adminJobHistoryItem")[2];
    await act(async () =>
      oldest?.querySelector<HTMLButtonElement>("button")?.click(),
    );
    const poll = timer.mock.calls.findLast(
      ([, delay]) => delay === 2 * historyPollMs,
    )?.[0];
    if (typeof poll !== "function") throw new Error("Missing history refresh");
    refreshed = true;
    await act(async () => {
      poll();
    });
    expect(container.querySelectorAll(".adminJobHistoryItem")).toHaveLength(4);
    expect(container.querySelectorAll(".adminJobHistoryItem")[3]).toBe(oldest);
    expect(container.textContent).toContain("Run ID: run-1");
    expect(
      timer.mock.calls.some(([, delay]) => delay === 3 * historyPollMs),
    ).toBe(true);
  } finally {
    timer.mockRestore();
  }
});
