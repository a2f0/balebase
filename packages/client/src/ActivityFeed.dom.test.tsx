import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Activity } from "./Activity";
import { ActivityFeed } from "./ActivityFeed";
import type { ActivityEvent } from "./activityApi";

const dom = new Window({ url: "http://localhost:5173/activity" });
const domGlobals = {
  document: dom.document,
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

async function render(sourceId: string, refreshKey = 0) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root?.render(
      <ActivityFeed
        refreshKey={refreshKey}
        source={{ id: sourceId, type: "audit_run" }}
      />,
    ),
  );
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await settle();
}

function event(id: number, after: string): ActivityEvent {
  return {
    action: "audit.answer_changed",
    actor: { email: "sam@example.com", id: "user-1", name: "Sam" },
    details: {
      after,
      before: "pass",
      prompt: "Exits clear",
      responseType: "check",
    },
    historical: false,
    id,
    occurredAt: "2026-10-02T12:00:00.000Z",
    root: { id: "audit-1", label: "Fire safety", type: "audit_run" },
    subject: { id: "exits", type: "audit_answer" },
  };
}

function equipmentEvents(): ActivityEvent[] {
  const equipmentEvent = (
    id: number,
    action: string,
    label: string,
    details: ActivityEvent["details"],
  ): ActivityEvent => ({
    ...event(id, ""),
    action,
    details,
    root: { id: "laptop/1", label, type: "equipment" },
    subject: { id: "laptop/1", type: "equipment" },
  });
  return [
    equipmentEvent(54, "equipment.deleted", "Apple MacBook Air", {
      make: "Apple",
      model: "MacBook Air",
      purchaseDate: null,
      serialNumber: null,
      type: "monitor",
    }),
    equipmentEvent(53, "equipment.assigned", "Apple MacBook Air", {
      after: "bob-user",
      afterEmail: "bob@example.com",
      afterName: "Bob",
      before: null,
      beforeEmail: null,
      beforeName: null,
    }),
    equipmentEvent(52, "equipment.updated", "Apple MacBook Air", {
      changes: [
        { after: "MacBook Air", before: "MacBook Pro", field: "model" },
        { after: null, before: "C02XYZ", field: "serialNumber" },
        { after: "monitor", before: "computer", field: "type" },
      ],
    }),
    equipmentEvent(51, "equipment.created", "Apple MacBook Pro", {
      assignedTo: null,
      assigneeEmail: null,
      assigneeName: null,
      make: "Apple",
      model: "MacBook Pro",
      purchaseDate: null,
      serialNumber: "C02XYZ",
      type: "computer",
    }),
  ];
}

describe("activity feed, mounted", () => {
  it.each([true, false])(
    "shows role changes and member navigation (compact: %s)",
    async (compact) => {
      const change: ActivityEvent = {
        ...event(51, "admin"),
        action: "organization.member_role_changed",
        details: {
          before: "member",
          after: "admin,owner",
          userId: "bob-user",
          userName: "Bob",
          userEmail: "bob@example.com",
        },
        root: { type: "organization_member", id: "bob/member", label: "Bob" },
        subject: { type: "organization_member", id: "bob/member" },
      };
      globalThis.fetch = (async (_input) =>
        Response.json({ events: [change], nextCursor: null })) as typeof fetch;
      const navigations: string[] = [];
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root?.render(
          <ActivityFeed
            compact={compact}
            onNavigate={(path) => navigations.push(path)}
          />,
        ),
      );
      await settle();
      expect(container.textContent).toContain(
        "Sam changed an organization role",
      );
      expect(container.textContent).toContain("Bob · bob@example.com");
      expect(container.textContent).toContain("Member → Admin, Owner");
      expect(container.textContent).not.toContain("Open form");
      if (compact) {
        expect(container.querySelector("summary")?.textContent).toBe(
          "Bob · Member → Admin, Owner",
        );
        expect(
          container.querySelector('[aria-label="Open member: Bob"]'),
        ).not.toBeNull();
      }
      await click(compact ? "Bob" : "Open member");
      expect(navigations).toEqual(["/organization/people/bob%2Fmember"]);
    },
  );

  it.each([true, false])(
    "names the API key and channel behind a change (compact: %s)",
    async (compact) => {
      const viaKey = (
        id: number,
        channel: "mcp" | "rest",
        name: string,
      ): ActivityEvent => ({
        ...event(id, "fail"),
        actor: {
          ...event(id, "fail").actor,
          apiKey: { channel, id: `key-${id}`, name },
        },
      });
      globalThis.fetch = (async (_input) =>
        Response.json({
          events: [
            viaKey(3, "mcp", "Claude Desktop"),
            viaKey(2, "rest", "Reporting"),
            event(1, "pass"),
          ],
          nextCursor: null,
        })) as typeof fetch;
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root?.render(<ActivityFeed compact={compact} />));
      await settle();
      expect(
        [...container.querySelectorAll(".activityHeading")].map(
          (heading) => heading.textContent,
        ),
      ).toEqual([
        "Sam via Claude Desktop (MCP) changed an answer",
        "Sam via Reporting (API) changed an answer",
        "Sam changed an answer",
      ]);
      expect(
        [...container.querySelectorAll(".activityApiKey")].map((label) =>
          label.getAttribute("title"),
        ),
      ).toEqual([
        "API key, called through MCP",
        "API key, called through the REST API",
      ]);
    },
  );

  it("shows equipment history and links only to equipment that still exists", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        events: equipmentEvents(),
        nextCursor: null,
      })) as typeof fetch;
    const navigations: string[] = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <Activity onNavigate={(pathname) => navigations.push(pathname)} />,
      ),
    );
    await settle();
    expect(
      [...container.querySelectorAll(".activityHeading")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      "Sam deleted equipment · Apple MacBook Air",
      "Sam changed the equipment assignee · Apple MacBook Air",
      "Sam edited equipment · Apple MacBook Air",
      "Sam added equipment · Apple MacBook Pro",
    ]);
    expect(
      [...container.querySelectorAll("summary")].map(
        (summary) => summary.textContent,
      ),
    ).toEqual([
      "Monitor",
      "Unassigned → Bob",
      "Model: MacBook Pro → MacBook Air · Serial number: C02XYZ → Not recorded · Type: Computer → Monitor",
      "Computer · C02XYZ",
    ]);
    expect(container.textContent).toContain("Computer · Apple MacBook Pro");
    expect(container.textContent).toContain(
      "Serial number: C02XYZ · Purchase date: Not recorded",
    );
    expect(container.textContent).toContain("Assigned to: Unassigned");
    expect(
      container.querySelectorAll(
        '[aria-label="Open equipment: Apple MacBook Air"]',
      ),
    ).toHaveLength(2);
    await click("Apple MacBook Pro");
    expect(navigations).toEqual(["/equipment/laptop%2F1"]);
  });

  it("reads one item's history through its equipment", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json({ events: equipmentEvents(), nextCursor: null });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ActivityFeed
          onNavigate={() => undefined}
          source={{ id: "laptop/1", type: "equipment" }}
        />,
      ),
    );
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEndWith("/api/equipment/laptop%2F1/activity");
    expect(container.textContent).toContain("Unassigned → Bob");
    expect(container.textContent).toContain("Model: MacBook Pro → MacBook Air");
    expect(container.textContent).not.toContain("Open equipment");
  });

  it("uses compact workspace rows with expandable full details and resource navigation", async () => {
    const change = event(51, "First line\nSecond line");
    change.details.before = "Previous answer ".repeat(50);
    change.details.responseType = "text";
    change.historical = true;
    const navigations: string[] = [];
    globalThis.fetch = (async (input) => {
      expect(String(input)).toEndWith("/api/activity");
      return Response.json({ events: [change], nextCursor: null });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <Activity onNavigate={(pathname) => navigations.push(pathname)} />,
      ),
    );
    await settle();
    expect(container.querySelector(".activityRowCompact")).not.toBeNull();
    expect(container.textContent).toContain("From existing records");
    const disclosure = container.querySelector<HTMLDetailsElement>(
      ".activityDisclosure",
    );
    expect(disclosure?.open).toBe(false);
    const summary = disclosure?.querySelector("summary");
    expect(summary?.textContent).toContain("Exits clear");
    await act(async () => summary?.click());
    expect(disclosure?.open).toBe(true);
    expect(disclosure?.textContent).toContain("sam@example.com");
    expect(disclosure?.textContent).toContain(String(change.details.before));
    expect(disclosure?.textContent).toContain("First line\nSecond line");
    await click("Fire safety");
    expect(navigations).toEqual(["/audits/runs/audit-1"]);
  });

  it("loads earlier events, refreshes manually, and reloads after a saved mutation", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      expect(init?.credentials).toBe("include");
      requests.push(String(input));
      return Response.json(
        requests.length === 2
          ? { events: [event(50, "na")], nextCursor: null }
          : { events: [event(51, "fail")], nextCursor: "51" },
      );
    }) as typeof fetch;
    await render("audit/id");
    expect(container.textContent).toContain("Sam changed an answer");
    expect(container.textContent).toContain("sam@example.com");
    expect(container.textContent).toContain("Exits clear");
    expect(container.textContent).toContain("Fail");
    await click("Load more activity");
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);
    expect(container.textContent).toContain("N/A");
    expect(requests[1]).toEndWith(
      "/api/audits/runs/audit%2Fid/activity?cursor=51",
    );
    await click("Refresh activity");
    expect(requests).toHaveLength(3);
    expect(container.querySelectorAll(".activityRow")).toHaveLength(1);
    await render("audit/id", 1);
    expect(requests).toHaveLength(4);
  });

  it("ignores a previous audit's response after navigating to another audit", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/previous/")) {
        return new Promise<Response>((resolve) => {
          resolvePrevious = resolve;
        });
      }
      return Response.json({
        events: [event(5, "Current answer")],
        nextCursor: null,
      });
    }) as typeof fetch;
    await render("previous");
    await render("current");
    await act(async () =>
      resolvePrevious?.(
        Response.json({ events: [event(4, "Stale answer")], nextCursor: null }),
      ),
    );
    await settle();
    expect(container.textContent).toContain("Current answer");
    expect(container.textContent).not.toContain("Stale answer");
  });

  it("lets the user retry when loading activity fails", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input) => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: "Activity unavailable" }, { status: 500 })
        : Response.json({ events: [], nextCursor: null });
    }) as typeof fetch;
    await render("audit-1");
    expect(container.textContent).toContain("Activity unavailable");
    await click("Refresh activity");
    expect(container.textContent).toContain("No activity yet");
    expect(container.textContent).not.toContain("Activity unavailable");
  });
});

it("shows annotation changes and links issue events to their issue", async () => {
  const changes: ActivityEvent[] = [
    {
      ...event(2, ""),
      action: "finance.transaction_annotated",
      root: { type: "finance_transaction", id: "txn/1", label: "Coffee" },
      subject: { type: "finance_transaction", id: "txn/1" },
      details: {
        before: { note: "Missing receipt", labels: ["tax"], reviewed: false },
        after: { note: "", labels: [], reviewed: true },
      },
    },
    {
      ...event(1, ""),
      action: "issue.created",
      root: { type: "finance_transaction", id: "txn/1", label: "Coffee" },
      subject: { type: "issue", id: "issue/1" },
      details: { title: "Duplicate charge", priority: "high" },
    },
  ];
  globalThis.fetch = (async (_input) =>
    Response.json({ events: changes, nextCursor: null })) as typeof fetch;
  const paths: string[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<ActivityFeed onNavigate={(path) => paths.push(path)} />),
  );
  expect(container.textContent).toContain("updated a transaction annotation");
  expect(container.textContent).toContain("Missing receipt");
  expect(container.textContent).toContain("None");
  expect(container.textContent).toContain("Not reviewed");
  expect(container.textContent).toContain("Duplicate charge");
  await click("Open transaction");
  await click("Open issue");
  expect(paths).toEqual(["/finance/transactions/txn%2F1", "/issues/issue%2F1"]);
});
