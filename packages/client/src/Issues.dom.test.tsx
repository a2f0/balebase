import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { FinanceTransactionPage } from "./FinanceTransactionPage";
import { Issues } from "./Issues";
import type { Issue } from "./issuesApi";

const dom = new Window({ url: "http://localhost:5173/finance" });
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;
beforeAll(async () => {
  for (const [key, value] of Object.entries({
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  })) {
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

function respond(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(new URL(input.toString()), init))) as typeof fetch;
}
const issue: Issue = {
  id: "issue-1",
  title: "Duplicate charge",
  description: "Check bank",
  priority: "high",
  status: "open",
  target: {
    type: "finance_transaction",
    id: "old-txn",
    itemId: null,
    label: "Coffee",
    available: true,
  },
  assignedTo: null,
  createdBy: { id: "user", name: "Sam", email: "sam@example.com" },
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
  revision: 0,
};
const transaction = {
  id: "old-txn",
  name: "Coffee",
  merchantName: null,
  accountName: "Checking",
  amount: 25,
  currencyCode: "USD",
  transactionDate: "2018-01-01",
  annotation: { labels: [], note: "", reviewed: false },
  linkedEmails: [],
  expenseCategoryId: null,
};
async function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}
async function submit() {
  await act(async () =>
    container.querySelector("form")?.dispatchEvent(
      new dom.Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    ),
  );
}
function baseResponse(url: URL) {
  if (url.pathname.endsWith("/members")) return Response.json({ members: [] });
  if (url.pathname.endsWith("/activity"))
    return Response.json({ events: [], nextCursor: null });
  if (url.pathname === "/api/finance/transactions/old-txn")
    return Response.json({ transaction, categories: [] });
  throw new Error(`Unexpected request ${url}`);
}

describe("workspace issues, mounted", () => {
  it("filters issues and navigates from a result", async () => {
    const queries: URLSearchParams[] = [];
    const paths: string[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json({ issues: [issue], nextCursor: null });
    });
    await mount(
      <Issues
        pathname="/issues"
        canAccessFinance
        onNavigate={(path) => paths.push(path)}
      />,
    );
    expect(container.textContent).toContain("Duplicate charge");
    expect(queries[0]?.get("status")).toBe("open");
    const status = container.querySelector("select");
    await act(async () => {
      if (status) {
        status.value = "resolved";
        status.dispatchEvent(
          new dom.Event("change", { bubbles: true }) as unknown as Event,
        );
      }
    });
    expect(queries.at(-1)?.get("status")).toBe("resolved");
    await act(async () =>
      container
        .querySelector<HTMLAnchorElement>('a[href="/issues/issue-1"]')
        ?.click(),
    );
    expect(paths).toEqual(["/issues/issue-1"]);
  });

  it("raises an issue for the selected transaction and keeps input after a failed save", async () => {
    const writes: unknown[] = [];
    const paths: string[] = [];
    let fail = true;
    respond((url, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return fail
          ? Response.json({ error: "Try again" }, { status: 503 })
          : Response.json({ issueId: "new-issue" });
      }
      return baseResponse(url);
    });
    await mount(
      <Issues
        pathname="/issues/new/transactions/old-txn"
        canAccessFinance
        onNavigate={(path) => paths.push(path)}
      />,
    );
    expect(container.textContent).toContain("Coffee");
    // Native setter and input event exercise React's controlled input handling.
    const input = container.querySelector("input");
    await act(async () => {
      if (input) {
        Object.getOwnPropertyDescriptor(
          dom.HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "Duplicate charge");
        input.dispatchEvent(
          new dom.Event("input", { bubbles: true }) as unknown as Event,
        );
      }
    });
    await submit();
    expect(container.textContent).toContain("Try again");
    expect(input?.value).toBe("Duplicate charge");
    expect(paths).toEqual([]);
    fail = false;
    await submit();
    expect(writes.at(-1)).toMatchObject({
      title: "Duplicate charge",
      target: { type: "finance_transaction", id: "old-txn" },
    });
    expect(paths).toEqual(["/issues/new-issue"]);
  });

  it("resolves, reopens, and opens the exact source transaction; stale saves offer reload", async () => {
    let current = { ...issue };
    let stale = false;
    const writes: Record<string, unknown>[] = [];
    const paths: string[] = [];
    respond((url, init) => {
      if (url.pathname === "/api/issues/issue-1") {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          if (stale)
            return Response.json(
              { error: "This issue changed. Reload before saving." },
              { status: 409 },
            );
          current = { ...current, ...body, revision: current.revision + 1 };
        }
        return Response.json({ issue: current });
      }
      return baseResponse(url);
    });
    await mount(
      <Issues
        pathname="/issues/issue-1"
        canAccessFinance
        onNavigate={(path) => paths.push(path)}
      />,
    );
    const draft = container.querySelector("textarea");
    await act(async () => {
      if (draft) {
        Object.getOwnPropertyDescriptor(
          dom.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(draft, "Unsaved investigation");
        draft.dispatchEvent(
          new dom.Event("input", { bubbles: true }) as unknown as Event,
        );
      }
    });
    await click("Resolve issue");
    expect(container.querySelector("textarea")?.value).toBe(
      "Unsaved investigation",
    );
    expect(writes[0]).toMatchObject({
      status: "resolved",
      expectedRevision: 0,
    });
    expect(container.textContent).toContain("Resolved issue");
    await click("Reopen issue");
    expect(writes[1]).toMatchObject({ status: "open", expectedRevision: 1 });
    await click("Open transaction");
    expect(paths).toEqual(["/finance/transactions/old-txn"]);
    stale = true;
    await submit();
    expect(container.textContent).toContain("Reload issue");
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
    stale = false;
    current = {
      ...current,
      title: "New remote title",
      description: "Saved by another member",
      revision: current.revision + 1,
    };
    await click("Reload issue");
    expect(container.querySelector("textarea")?.value).toBe(
      "Saved by another member",
    );
    expect(container.querySelector("input")?.value).toBe("New remote title");
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
  });

  it("shows transaction issues and history outside the overview's filters", async () => {
    const paths: string[] = [];
    const requests: string[] = [];
    respond((url) => {
      requests.push(url.pathname + url.search);
      if (url.pathname === "/api/issues")
        return Response.json({ issues: [issue], nextCursor: null });
      return baseResponse(url);
    });
    await mount(
      <FinanceTransactionPage
        id="old-txn"
        onNavigate={(path) => paths.push(path)}
      />,
    );
    expect(container.textContent).toContain("Duplicate charge");
    expect(
      container
        .querySelector(".financeTransaction")
        ?.closest(".financeListCard"),
    ).not.toBeNull();
    expect(requests).toContain("/api/finance/transactions/old-txn/activity");
    expect(requests.some((url) => url.includes("targetId=old-txn"))).toBe(true);
    await click("Raise issue");
    expect(paths).toEqual(["/issues/new/transactions/old-txn"]);
  });
});

it("handles malformed issue links without a render exception", async () => {
  const requests: string[] = [];
  respond((url) => {
    requests.push(url.pathname);
    return Response.json({ error: "Issue not found." }, { status: 404 });
  });
  await mount(
    <Issues
      pathname="/issues/%E0"
      canAccessFinance
      onNavigate={() => undefined}
    />,
  );
  expect(container.textContent).toContain("Issue not found.");
  expect(requests).toEqual(["/api/issues/%25E0"]);
});
