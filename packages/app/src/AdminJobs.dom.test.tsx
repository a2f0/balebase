import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { JobRun } from "@balebase/validators/adminJobs";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AdminJobs } from "./AdminJobs";

const dom = new Window({ url: "http://localhost:5173/root/jobs" });
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

const queued: JobRun = {
  runId: "run-1",
  jobId: "purgeRequestedUsers",
  status: "queued",
  source: "manual",
  requestedBy: "actor",
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
const definitions = [
  {
    id: "purgeRequestedUsers",
    name: "Purge requested user accounts",
    description: "Purges eligible accounts.",
    manual: true,
  },
  {
    id: "syncFinanceConnection",
    name: "Sync bank accounts",
    description: "Start sync from Finance.",
    manual: false,
  },
];

function button(label: string) {
  const match = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <AdminJobs />
        <DialogHost />
      </>,
    ),
  );
}

it("queues confirmed maintenance, exposes persisted output after remount, and filters bank jobs", async () => {
  let completed = false;
  const requests: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
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
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  await render();
  expect(container.textContent).toContain("30 days");
  expect(container.textContent).toContain("Sync bank accounts");
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
  expect(container.textContent).toContain("Job queued.");
  expect(container.textContent).not.toContain("Job completed.");
  completed = true;
  await act(async () => root?.unmount());
  container.remove();
  await render();
  await act(async () => button("View run").click());
  expect(container.textContent).toContain('"purged": 3');
  expect(container.textContent).toContain("succeeded");
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing job filter");
  await act(async () => {
    select.value = "syncFinanceConnection";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(requests).toContain(
    "GET /api/admin/jobs/runs?jobId=syncFinanceConnection",
  );
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/runs/run-1"))
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    if (url.pathname.endsWith("/runs/run-2"))
      return Response.json({ run: failed, logs: [], nextBefore: null });
    if (url.pathname.endsWith("/runs"))
      return Response.json({ runs: [queued, failed], nextCursor: null });
    return Response.json({ jobs: definitions });
  }) as typeof fetch;
  await render();
  const views = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "View run",
  );
  await act(async () => views[0]?.click());
  await act(async () =>
    [...container.querySelectorAll("button")]
      .filter((item) => item.textContent === "View run")[1]
      ?.click(),
  );
  expect(container.textContent).toContain("INTERRUPTED");
  await act(async () =>
    finishFirst?.(Response.json({ run: queued, logs: [], nextBefore: null })),
  );
  expect(container.textContent).toContain("Run ID: run-2");
  expect(container.textContent).not.toContain("Run ID: run-1");
});
