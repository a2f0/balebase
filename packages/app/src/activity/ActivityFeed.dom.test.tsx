import { describe, expect, it } from "bun:test";
import type { ActivityEvent } from "@balebase/validators/activity";
import { act } from "react";
import { installDom } from "../testing/dom";
import { Activity } from "./Activity";
import { ActivityFeed } from "./ActivityFeed";

const {
  click,
  mount,
  render,
  respond,
  settle,
  window: dom,
} = installDom({ url: "http://localhost:5173/activity" });
let container: HTMLElement;

async function renderFeed(sourceId: string, refreshKey = 0) {
  ({ container } = await render(
    <ActivityFeed
      refreshKey={refreshKey}
      source={{ id: sourceId, type: "audit_run" }}
    />,
  ));
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
  it("keeps the resource filter while paging and refreshing, and resets it on change", async () => {
    const requests: URL[] = [];
    respond(async (url) => {
      requests.push(url);
      return Response.json({
        events: [event(url.searchParams.has("cursor") ? 50 : 51, "pass")],
        nextCursor: url.searchParams.has("cursor") ? null : "51",
      });
    });
    const view = await mount(
      <Activity canAccessFinance onNavigate={() => {}} />,
    );
    container = view.container;
    await settle();
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(container.textContent).toContain("Transactions");
    async function choose(value: string) {
      await act(async () => {
        if (select) {
          select.value = value;
          select.dispatchEvent(
            new dom.Event("change", { bubbles: true }) as unknown as Event,
          );
        }
      });
      await settle();
    }
    await choose("equipment");
    expect(requests.at(-1)?.search).toBe("?resourceType=equipment");
    await click("Load more activity");
    expect(requests.at(-1)?.searchParams.get("cursor")).toBe("51");
    expect(requests.at(-1)?.searchParams.get("resourceType")).toBe("equipment");
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);
    await click("Refresh activity");
    expect(requests.at(-1)?.search).toBe("?resourceType=equipment");
    expect(container.querySelectorAll(".activityRow")).toHaveLength(1);
    await choose("finance_transaction");
    expect(requests.at(-1)?.search).toBe("?resourceType=finance_transaction");
    await choose("finance_connection");
    expect(requests.at(-1)?.search).toBe("?resourceType=finance_connection");
    await view.render(<Activity onNavigate={() => {}} />);
    await settle();
    expect(requests.at(-1)?.search).toBe("");
    expect(container.textContent).not.toContain("Transactions");
    expect(container.textContent).not.toContain("Bank connections");
    await view.render(<Activity canAccessFinance onNavigate={() => {}} />);
    await settle();
    expect(container.querySelector("select")?.value).toBe("");
    expect(requests.at(-1)?.search).toBe("");
  });

  it("offers the Groups filter only to organization managers", async () => {
    const requests: URL[] = [];
    respond(async (url) => {
      requests.push(url);
      return Response.json({ events: [], nextCursor: null });
    });
    const view = await mount(<Activity canManage onNavigate={() => {}} />);
    container = view.container;
    await settle();
    const select = container.querySelector("select");
    expect(container.textContent).toContain("Groups");
    await act(async () => {
      if (select) {
        select.value = "organization_group";
        select.dispatchEvent(
          new dom.Event("change", { bubbles: true }) as unknown as Event,
        );
      }
    });
    await settle();
    expect(requests.at(-1)?.search).toBe("?resourceType=organization_group");
    // Losing manager access drops the filter.
    await view.render(<Activity onNavigate={() => {}} />);
    await settle();
    expect(container.textContent).not.toContain("Groups");
    expect(requests.at(-1)?.search).toBe("");
  });

  it("ignores a response from the previous resource filter", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    respond(async (url) => {
      if (!url.href.includes("resourceType="))
        return new Promise<Response>((resolve) => {
          resolvePrevious = resolve;
        });
      return Response.json({
        events: [event(5, "Current resource")],
        nextCursor: null,
      });
    });
    ({ container } = await mount(<Activity onNavigate={() => {}} />));
    const select = container.querySelector("select");
    await act(async () => {
      if (select) {
        select.value = "audit_run";
        select.dispatchEvent(
          new dom.Event("change", { bubbles: true }) as unknown as Event,
        );
      }
    });
    await settle();
    await act(async () =>
      resolvePrevious?.(
        Response.json({
          events: [event(4, "Stale resource")],
          nextCursor: null,
        }),
      ),
    );
    await settle();
    expect(container.textContent).toContain("Current resource");
    expect(container.textContent).not.toContain("Stale resource");
  });

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
      respond(async () =>
        Response.json({ events: [change], nextCursor: null }),
      );
      const navigations: string[] = [];
      ({ container } = await mount(
        <ActivityFeed
          compact={compact}
          onNavigate={(path) => navigations.push(path)}
        />,
      ));
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
    "shows two-factor requirement changes (compact: %s)",
    async (compact) => {
      const change: ActivityEvent = {
        ...event(51, ""),
        action: "organization.member_two_factor_requirement_changed",
        details: {
          after: true,
          before: false,
          userEmail: "bob@example.com",
          userId: "bob-user",
          userName: "Bob",
        },
        root: { type: "organization_member", id: "bob-member", label: "Bob" },
        subject: { type: "organization_member", id: "bob-member" },
      };
      respond(async () =>
        Response.json({ events: [change], nextCursor: null }),
      );
      const navigations: string[] = [];
      ({ container } = await mount(
        <ActivityFeed
          compact={compact}
          onNavigate={(path) => navigations.push(path)}
        />,
      ));
      await settle();
      expect(container.textContent).toContain(
        "Sam changed a two-factor requirement",
      );
      expect(container.textContent).toContain(
        "Two-factor: Not required → Required",
      );
      if (compact)
        expect(container.querySelector("summary")?.textContent).toBe(
          "Bob · Two-factor: Not required → Required",
        );
      await click(compact ? "Bob" : "Open member");
      expect(navigations).toEqual(["/organization/people/bob-member"]);
    },
  );

  it("shows group grants, revocations, and snapshots", async () => {
    const group = (
      id: number,
      action: string,
      details: ActivityEvent["details"],
    ): ActivityEvent => ({
      ...event(id, ""),
      action,
      details,
      root: { id: "group-1", label: "Finance", type: "organization_group" },
      subject: { id: "group-1", type: "organization_group" },
    });
    const bob = { email: "bob@example.com", name: "Bob", userId: "bob-user" };
    const ann = { email: "ann@example.com", name: "", userId: "ann-user" };
    respond(async () =>
      Response.json({
        events: [
          group(53, "organization.group_deleted", {
            capabilities: [],
            members: [],
            name: "Finance",
          }),
          group(52, "organization.group_updated", {
            addedCapabilities: [],
            addedMembers: [bob],
            name: "Finance",
            removedCapabilities: ["finance"],
            removedMembers: [ann],
            renamedFrom: "Books",
          }),
          group(51, "organization.group_created", {
            capabilities: ["finance"],
            members: [bob],
            name: "Books",
          }),
        ],
        nextCursor: null,
      }),
    );
    const navigations: string[] = [];
    ({ container } = await mount(
      <ActivityFeed onNavigate={(path) => navigations.push(path)} />,
    ));
    await settle();
    const rows = [...container.querySelectorAll(".activityRow")].map(
      (row) => row.textContent,
    );
    expect(rows[0]).toContain("Sam deleted a group");
    expect(rows[0]).toContain("No members · No access");
    expect(rows[0]).not.toContain("Open groups");
    expect(rows[1]).toContain("Sam changed a group");
    expect(rows[1]).toContain(
      "Renamed from Books · Added: Bob · Removed: ann@example.com · Access removed: Finance",
    );
    expect(rows[2]).toContain("Sam created a group");
    expect(rows[2]).toContain("Members: Bob · Access: Finance");
    await click("Open groups");
    expect(navigations).toEqual(["/organization/access"]);
  });

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
      respond(async () =>
        Response.json({
          events: [
            viaKey(3, "mcp", "Claude Desktop"),
            viaKey(2, "rest", "Reporting"),
            event(1, "pass"),
          ],
          nextCursor: null,
        }),
      );
      ({ container } = await mount(<ActivityFeed compact={compact} />));
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
    respond(async () =>
      Response.json({
        events: equipmentEvents(),
        nextCursor: null,
      }),
    );
    const navigations: string[] = [];
    ({ container } = await mount(
      <Activity onNavigate={(pathname) => navigations.push(pathname)} />,
    ));
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
    respond(async (url) => {
      requests.push(url.href);
      return Response.json({ events: equipmentEvents(), nextCursor: null });
    });
    ({ container } = await mount(
      <ActivityFeed
        onNavigate={() => undefined}
        source={{ id: "laptop/1", type: "equipment" }}
      />,
    ));
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
    respond(async (url) => {
      expect(url.href).toEndWith("/api/activity");
      return Response.json({ events: [change], nextCursor: null });
    });
    ({ container } = await mount(
      <Activity onNavigate={(pathname) => navigations.push(pathname)} />,
    ));
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
    respond(async (url, init) => {
      expect(init?.credentials).toBe("include");
      requests.push(url.href);
      return Response.json(
        requests.length === 2
          ? { events: [event(50, "na")], nextCursor: null }
          : { events: [event(51, "fail")], nextCursor: "51" },
      );
    });
    await renderFeed("audit/id");
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
    await renderFeed("audit/id", 1);
    expect(requests).toHaveLength(4);
  });

  it("ignores a previous audit's response after navigating to another audit", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    respond(async (url) => {
      if (url.href.includes("/previous/")) {
        return new Promise<Response>((resolve) => {
          resolvePrevious = resolve;
        });
      }
      return Response.json({
        events: [event(5, "Current answer")],
        nextCursor: null,
      });
    });
    await renderFeed("previous");
    await renderFeed("current");
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
    respond(async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: "Activity unavailable" }, { status: 500 })
        : Response.json({ events: [], nextCursor: null });
    });
    await renderFeed("audit-1");
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
  respond(async () => Response.json({ events: changes, nextCursor: null }));
  const paths: string[] = [];
  ({ container } = await mount(
    <ActivityFeed onNavigate={(path) => paths.push(path)} />,
  ));
  expect(container.textContent).toContain("updated a transaction annotation");
  expect(container.textContent).toContain("Missing receipt");
  expect(container.textContent).toContain("None");
  expect(container.textContent).toContain("Not reviewed");
  expect(container.textContent).toContain("Duplicate charge");
  await click("Open transaction");
  await click("Open issue");
  expect(paths).toEqual(["/finance/transactions/txn%2F1", "/issues/issue%2F1"]);
});

it("names who changed an expense category, using the names recorded then", async () => {
  const category = (
    id: number,
    details: Record<string, unknown>,
    name: string,
  ): ActivityEvent => ({
    ...event(id, ""),
    action: "finance.transaction_categorized",
    actor: { email: `${name.toLowerCase()}@example.com`, id: name, name },
    root: { type: "finance_transaction", id: "txn-1", label: "Coffee" },
    subject: { type: "finance_transaction", id: "txn-1" },
    details,
  });
  const changes = [
    category(
      3,
      { before: "meals", beforeName: "Meals", after: null, afterName: null },
      "Alex",
    ),
    category(
      2,
      {
        before: "travel",
        beforeName: null,
        after: "meals",
        afterName: "Meals",
      },
      "Sam",
    ),
    category(
      1,
      { before: null, beforeName: null, after: "travel", afterName: "Travel" },
      "Sam",
    ),
  ];
  respond(async () => Response.json({ events: changes, nextCursor: null }));
  ({ container } = await mount(
    <ActivityFeed source={{ type: "finance_transaction", id: "txn-1" }} />,
  ));
  const rows = [...container.querySelectorAll(".activityRow")].map(
    (row) => row.textContent ?? "",
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain("Alex changed the expense category");
  expect(rows[0]).toContain("Meals→changed toUncategorized");
  expect(rows[1]).toContain("Sam changed the expense category");
  expect(rows[1]).toContain("Deleted category→changed toMeals");
  expect(rows[2]).toContain("Uncategorized→changed toTravel");
});
