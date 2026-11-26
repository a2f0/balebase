import { afterEach, expect, it, spyOn } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { act } from "react";
import { holdTimers, installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { runPollMs } from "./AdminJobRun";
import { AdminJobs } from "./AdminJobs";
import { historyPollMs } from "./useJobHistory";

const { button, click, fill, mount, respond } = installDom({
  url: "http://localhost:5173/root/jobs",
  globals: () => ({
    IntersectionObserver: IntersectionObserverFixture,
  }),
});
let container: HTMLElement;
let navigations: string[] = [];

afterEach(() => {
  IntersectionObserverFixture.instances.length = 0;
  navigations = [];
});

const queued: JobRun = {
  runId: "run-1",
  jobId: "purgeRequestedUsers",
  status: "queued",
  source: "manual",
  dryRun: false,
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
    runSchedule: "Every hour at 17 minutes past the hour (UTC).",
    schedule: {
      cron: "17 * * * *",
      enabled: true,
      nextRunAt: "2026-10-26T12:17:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: null,
    },
  },
  {
    id: "syncFinanceConnection",
    name: "Sync bank accounts",
    description: "Start sync from Finance.",
    manual: false,
    runSchedule:
      "Once per UTC day for connections with daily sync enabled; checked every 5 minutes from 00:00 UTC. Manual sync from Finance.",
    schedule: null,
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

it("clears a run's logs while another page of them opens", async () => {
  const done: JobRun = { ...queued, status: "succeeded", attempts: 1 };
  const log = (id: number, message: string) => ({
    id,
    occurredAt: queued.createdAt,
    level: "info",
    message,
    details: {},
  });
  const pages: (string | null)[] = [];
  let finishEarlier: ((response: Response) => void) | undefined;
  respond(async (url) => {
    if (url.pathname.endsWith("/runs/run-1")) {
      const before = url.searchParams.get("before");
      pages.push(before);
      if (before === "cursor-1")
        return new Promise<Response>((resolve) => {
          finishEarlier = resolve;
        });
      return Response.json({
        run: done,
        logs: [log(2, "Newest log.")],
        nextBefore: "cursor-1",
      });
    }
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [done], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  await act(async () => button("View run").click());
  expect(container.textContent).toContain("Newest log.");
  await act(async () => button("Earlier logs").click());
  // The latest logs belong to another page, so they go while it loads.
  expect(container.textContent).toContain("Loading job output…");
  expect(container.textContent).not.toContain("Newest log.");
  await act(async () =>
    finishEarlier?.(
      Response.json({
        run: done,
        logs: [log(1, "Older log.")],
        nextBefore: null,
      }),
    ),
  );
  expect(container.textContent).toContain("Older log.");
  await act(async () => button("Latest logs").click());
  expect(container.textContent).toContain("Newest log.");
  expect(container.textContent).not.toContain("Older log.");
  expect(pages).toEqual([null, "cursor-1", null]);
});

async function render(pathname = "/root/jobs") {
  const view = await mount(
    <>
      <AdminJobs
        onNavigate={(path) => navigations.push(path)}
        pathname={pathname}
      />
      <DialogHost />
    </>,
  );
  container = view.container;
  return view;
}

/** Opens a job's row menu and picks one of its actions. */
async function chooseAction(
  label: string,
  jobName = "Purge requested user accounts",
) {
  await act(async () => button(`Actions for ${jobName}`).click());
  await act(async () => button(label).click());
}

function menuItems() {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].map((item) => item.textContent);
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
  expect(container.textContent).not.toContain("Manual only in staging");
  await act(async () => button("Actions for Sync bank accounts").click());
  expect(menuItems()).toEqual(["View history"]);
  await act(async () => button("View history").click());
  expect(navigations).toEqual(["/root/jobs/syncFinanceConnection"]);
  await chooseAction("Run now");
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
  let firstSignal: AbortSignal | null | undefined;
  const failed: JobRun = {
    ...queued,
    runId: "run-2",
    status: "failed",
    errorCode: "INTERRUPTED",
    error: "Review completed work before retrying.",
  };
  respond(async (url, init) => {
    if (url.pathname.endsWith("/runs/run-1")) {
      firstSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    }
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
  expect(firstSignal?.aborted).toBe(false);
  await act(async () => views[1]?.click());
  // Closing a run cancels its read, not only what it would show.
  expect(firstSignal?.aborted).toBe(true);
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
  await chooseAction("Run now");
  await act(async () => button("Run job").click());
  expect(container.querySelector("select")?.value).toBe("");
  expect(
    button("Hide run").closest(".adminJobHistoryItem")?.textContent,
  ).toContain("Run ID: run-1");
  expect(container.textContent).not.toContain("No runs match");
  // Reusing the same active job must reopen its inline details after a collapse.
  await act(async () => button("Hide run").click());
  await chooseAction("Run now");
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
  await chooseAction("Run now");
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

it("offers run, dry run, and schedule actions in each maintenance job's menu", async () => {
  respond(async (url) => {
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  const row = button("Actions for Purge requested user accounts").closest(
    ".adminJobRow",
  );
  expect(row?.textContent).toContain(
    "Run schedule: Every hour at 17 minutes past the hour (UTC).",
  );
  expect(row?.textContent).toContain("Next run:");
  await act(async () =>
    button("Actions for Purge requested user accounts").click(),
  );
  expect(menuItems()).toEqual([
    "Run now",
    "Dry run",
    "Edit schedule",
    "Pause schedule",
    "View history",
  ]);
  await act(async () => button("View history").click());
  expect(navigations).toEqual(["/root/jobs/purgeRequestedUsers"]);
  const link = [...container.querySelectorAll("a")].find(
    (item) => item.textContent === "Purge requested user accounts",
  );
  expect(link?.getAttribute("href")).toBe("/root/jobs/purgeRequestedUsers");
});

it("queues a confirmed dry run and marks it in the history", async () => {
  const bodies: unknown[] = [];
  const dryRun: JobRun = { ...queued, dryRun: true };
  respond(async (url, init) => {
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ run: dryRun }, { status: 202 });
    }
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json({ run: dryRun, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  await chooseAction("Dry run");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "changes nothing",
  );
  await act(async () => button("Cancel").click());
  expect(bodies).toEqual([]);
  await chooseAction("Dry run");
  await act(async () => button("Start dry run").click());
  expect(bodies).toEqual([{ confirm: "purgeRequestedUsers", dryRun: true }]);
  const item = button("Hide run").closest(".adminJobHistoryItem");
  expect(item?.textContent).toContain("queued · manual · dry run");
  expect(item?.textContent).toContain("Nothing was changed.");
});

it("edits, validates, and pauses a job's schedule", async () => {
  const saves: unknown[] = [];
  let current = definitions[0] as JobDefinition;
  respond(async (url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        cron: string;
        enabled: boolean;
      };
      saves.push(body);
      current = {
        ...current,
        runSchedule: body.enabled
          ? "Every day at 03:00 UTC."
          : "Not scheduled; runs only on request.",
        schedule: {
          cron: body.cron,
          enabled: body.enabled,
          nextRunAt: body.enabled ? "2026-10-27T03:00:00.000Z" : null,
          updatedAt: "2026-10-26T12:00:00.000Z",
          updatedBy: {
            email: "actor@example.com",
            id: "actor",
            name: "Admin Actor",
          },
        },
      };
      return Response.json({ job: current });
    }
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render();
  await chooseAction("Edit schedule");
  const input = document.querySelector<HTMLInputElement>("dialog input");
  expect(input?.value).toBe("17 * * * *");
  await fill(input, "every day");
  await click("Save schedule");
  expect(saves).toEqual([]);
  // The prompt asks again, keeping what was typed and saying what is wrong.
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Enter five cron fields in UTC",
  );
  expect(document.querySelector<HTMLInputElement>("dialog input")?.value).toBe(
    "every day",
  );
  await fill(document.querySelector("dialog input"), "0 3 * * *");
  await click("Save schedule");
  expect(saves).toEqual([{ cron: "0 3 * * *", enabled: true }]);
  expect(container.textContent).toContain(
    "Run schedule: Every day at 03:00 UTC.",
  );

  await chooseAction("Pause schedule");
  await click("Pause schedule");
  expect(saves.at(-1)).toEqual({ cron: "0 3 * * *", enabled: false });
  expect(container.textContent).toContain(
    "Run schedule: Not scheduled; runs only on request.",
  );
  await act(async () =>
    button("Actions for Purge requested user accounts").click(),
  );
  expect(menuItems()).toContain("Resume schedule");
});

it("shows one job's schedule, its own run history, and its schedule changes", async () => {
  const requests: string[] = [];
  respond(async (url) => {
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/schedule/changes"))
      return Response.json({
        changes: [
          {
            actor: {
              email: "actor@example.com",
              id: "actor",
              name: "Admin Actor",
            },
            changedAt: "2026-10-26T12:00:00.000Z",
            cron: "17 * * * *",
            enabled: false,
            id: "change-1",
            jobId: "purgeRequestedUsers",
            previousCron: "17 * * * *",
            previousEnabled: true,
          },
        ],
        nextCursor: null,
      });
    if (url.pathname.endsWith("/requests"))
      return Response.json({ requests: [], nextCursor: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [queued], nextCursor: null });
    return Response.json({ jobs: definitions });
  });
  await render("/root/jobs/purgeRequestedUsers");
  expect(container.querySelector("h1")?.textContent).toBe(
    "Purge requested user accounts",
  );
  expect(container.textContent).toContain("Cron (UTC): 17 * * * *");
  // Its history keeps the status filter but has no job filter to change.
  expect(container.textContent).not.toContain("All jobs");
  expect(container.textContent).toContain("All statuses");
  expect(requests).toContain("/api/admin/jobs/runs?jobId=purgeRequestedUsers");
  expect(requests).toContain(
    "/api/admin/jobs/requests?jobId=purgeRequestedUsers",
  );
  expect(container.textContent).toContain("Paused");
  expect(container.textContent).toContain("Admin Actor");
  await act(async () => button("Jobs").click());
  expect(navigations).toEqual(["/root/jobs"]);
});

it("reports a job that does not exist", async () => {
  respond(async () => Response.json({ jobs: definitions }));
  await render("/root/jobs/missing");
  expect(container.textContent).toContain("Job not found");
});
