import { afterEach, describe, expect, it } from "bun:test";
import type { ActivityEvent } from "@balebase/validators/activity";
import { act } from "react";
import { installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { Activity } from "./Activity";
import { ActivityFeed } from "./ActivityFeed";

const {
  click,
  mount,
  render,
  respond,
  settle,
  window: dom,
} = installDom({
  url: "http://localhost:5173/activity",
  globals: () => ({ IntersectionObserver: IntersectionObserverFixture }),
});
let container: HTMLElement;

afterEach(() => {
  IntersectionObserverFixture.instances.length = 0;
});

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
    actor: {
      email: "sam@example.com",
      id: "user-1",
      name: "Sam",
      source: null,
      type: "user",
    },
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
    await choose("finance_category");
    expect(requests.at(-1)?.search).toBe("?resourceType=finance_category");
    // Billing is for organization managers.
    expect(container.textContent).not.toContain("Billing");
    await view.render(<Activity onNavigate={() => {}} />);
    await settle();
    expect(requests.at(-1)?.search).toBe("");
    expect(container.textContent).not.toContain("Transactions");
    expect(container.textContent).not.toContain("Bank connections");
    expect(container.textContent).not.toContain("Expense categories");
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
    await act(async () => {
      if (select) {
        select.value = "organization_billing";
        select.dispatchEvent(
          new dom.Event("change", { bubbles: true }) as unknown as Event,
        );
      }
    });
    await settle();
    expect(requests.at(-1)?.search).toBe("?resourceType=organization_billing");
    // Losing manager access drops the filter.
    await view.render(<Activity onNavigate={() => {}} />);
    await settle();
    expect(container.textContent).not.toContain("Groups");
    expect(container.textContent).not.toContain("Billing");
    expect(requests.at(-1)?.search).toBe("");
  });

  it("shows contract and request history, linking only to records that remain", async () => {
    const record = (
      id: number,
      action: string,
      root: ActivityEvent["root"],
      details: ActivityEvent["details"],
    ): ActivityEvent => ({
      ...event(id, ""),
      action,
      actor: {
        apiKey: { channel: "mcp", id: "key", name: "Assistant" },
        email: "sam@example.com",
        id: "user-1",
        name: "Sam",
        source: null,
        type: "user",
      },
      details,
      root,
      subject: { id: root.id, type: root.type },
    });
    const contract = { id: "c/1", label: "Lease", type: "contract" };
    const request = {
      id: "r1",
      label: "W-4 · Bob",
      type: "employee_requirement",
    };
    const person = { kind: "form", personName: "Bob", title: "W-4" };
    respond(async () =>
      Response.json({
        events: [
          record(
            8,
            "contract_template.version_saved",
            { id: "t2", label: "Offer letter", type: "contract_template" },
            {
              fieldCount: 5,
              name: "Offer letter",
              previousName: "Offer",
              roleCount: 2,
              sourceVersion: 1,
              version: 2,
            },
          ),
          record(
            7,
            "contract_template.created",
            { id: "t2", label: "Offer", type: "contract_template" },
            { name: "Offer", pageCount: 2, version: 1 },
          ),
          record(6, "contract.deleted", contract, {
            declinedAt: "2026-10-30T12:00:00.000Z",
            signedCount: 1,
            signerCount: 2,
            status: "declined",
            templateName: null,
          }),
          record(5, "contract.voided", contract, {
            reason: "Wrong rate",
            signedCount: 1,
            signerCount: 2,
          }),
          record(4, "contract.sent", contract, {
            dueDate: "2026-11-01",
            signerCount: 2,
            signingOrder: "sequential",
          }),
          record(
            3,
            "contract_template.deleted",
            { id: "t1", label: "Offer", type: "contract_template" },
            { version: 3, versionCount: 3 },
          ),
          record(2, "employee_requirement.status_changed", request, {
            ...person,
            after: "complete",
            before: "submitted",
            checkrReport: false,
          }),
          record(1, "employee_requirement.document_uploaded", request, {
            ...person,
            replaced: true,
            revision: 2,
            uploadedBySubject: false,
          }),
        ],
        nextCursor: null,
      }),
    );
    const navigations: string[] = [];
    ({ container } = await mount(
      <Activity canManage onNavigate={(path) => navigations.push(path)} />,
    ));
    await settle();
    expect(
      [...container.querySelectorAll(".activityHeading")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      "Sam via Assistant (MCP) saved a contract template version · Offer letter",
      "Sam via Assistant (MCP) uploaded a contract template · Offer",
      "Sam via Assistant (MCP) deleted a contract · Lease",
      "Sam via Assistant (MCP) voided a contract · Lease",
      "Sam via Assistant (MCP) sent a contract for signature · Lease",
      "Sam via Assistant (MCP) deleted a contract template · Offer",
      "Sam via Assistant (MCP) changed a request's status · W-4 · Bob",
      "Sam via Assistant (MCP) uploaded a requested form · W-4 · Bob",
    ]);
    expect(
      [...container.querySelectorAll("summary")].map(
        (summary) => summary.textContent,
      ),
    ).toEqual([
      "Version 2 from v1 · Renamed from Offer · 2 roles · 5 fields",
      "Version 1 · 2 pages",
      "Was Declined · 1 of 2 signers signed",
      "1 of 2 signers signed · Reason: Wrong rate",
      "2 signers · In order · Due 2026-11-01",
      "Version 3 · 3 versions removed",
      "W-4 · Form · Bob · Submitted → Complete (set by hand)",
      "W-4 · Form · Bob · Revision 2 · By a manager · Replaced the previous file",
    ]);
    // Deleted records have no page; the rest open their own.
    expect(
      [...container.querySelectorAll(".activityResource")].map((link) =>
        link.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Open template: Offer letter",
      "Open template: Offer",
      "Open contract: Lease",
      "Open contract: Lease",
      "Open request: W-4 · Bob",
      "Open request: W-4 · Bob",
    ]);
    await click("Open contract: Lease");
    await click("Open request: W-4 · Bob");
    expect(navigations).toEqual([
      "/contracts/c%2F1",
      "/organization/requests/r1",
    ]);
    expect(container.textContent).toContain("Requested forms and checks");
    ({ container } = await mount(<Activity onNavigate={() => {}} />));
    await settle();
    expect(container.textContent).not.toContain("Requested forms and checks");
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

  it("keeps the loaded events on screen while a saved change refreshes them", async () => {
    const cursors: (string | null)[] = [];
    let refreshed: ((response: Response) => void) | undefined;
    respond(async (url) => {
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor)
        return Response.json({ events: [event(50, "na")], nextCursor: "50" });
      if (cursors.length === 1)
        return Response.json({ events: [event(51, "fail")], nextCursor: "51" });
      return new Promise<Response>((resolve) => {
        refreshed = resolve;
      });
    });
    await renderFeed("audit-1");
    await act(async () => IntersectionObserverFixture.intersect());
    await settle();
    expect(cursors).toEqual([null, "51"]);
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);

    await renderFeed("audit-1", 1);
    expect(cursors).toEqual([null, "51", null]);
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);
    expect(container.textContent).not.toContain("Loading activity");
    // No older page loads into a list that is being replaced.
    await act(async () => IntersectionObserverFixture.intersect());
    await settle();
    expect(cursors).toEqual([null, "51", null]);

    await act(async () =>
      refreshed?.(
        Response.json({ events: [event(51, "pass")], nextCursor: "51" }),
      ),
    );
    await settle();
    expect(container.querySelectorAll(".activityRow")).toHaveLength(1);
    // The refreshed first page can page again, even to a cursor loaded before.
    await act(async () => IntersectionObserverFixture.intersect());
    await settle();
    expect(cursors).toEqual([null, "51", null, "51"]);
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);
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
    actor: {
      email: `${name.toLowerCase()}@example.com`,
      id: name,
      name,
      source: null,
      type: "user",
    },
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

it("summarizes bank, category, and billing changes and links what still exists", async () => {
  const change = (
    id: number,
    action: string,
    type: string,
    details: ActivityEvent["details"],
    label = "First Bank",
  ): ActivityEvent => ({
    ...event(id, ""),
    action,
    details,
    root: { id: `${type}-1`, label, type },
    subject: { id: `${type}-1`, type },
  });
  const changes = [
    change(
      7,
      "billing.checkout_started",
      "organization_billing",
      {
        checkoutSessionId: "cs_1",
        priceId: "price_1",
        quantity: 3,
      },
      "Acme",
    ),
    change(6, "finance.connection_data_deleted", "finance_connection", {
      accountCount: 2,
      annotationCount: 1,
      institutionName: "First Bank",
      transactionCount: 40,
    }),
    change(5, "finance.connection_created", "finance_connection", {
      institutionId: "ins_1",
      institutionName: "First Bank",
    }),
    change(
      4,
      "finance.category_renamed",
      "finance_category",
      {
        afterName: "Team meals",
        afterSlug: "team-meals",
        beforeName: "Meals",
        beforeSlug: "meals",
      },
      "Team meals",
    ),
    change(
      3,
      "finance.category_deleted",
      "finance_category",
      {
        name: "Fuel",
        slug: "fuel",
        transactionCount: 1,
      },
      "Fuel",
    ),
    change(
      2,
      "finance.categories_defaults_added",
      "finance_category",
      {
        names: ["Insurance", "Travel"],
      },
      "Expense categories",
    ),
    change(
      1,
      "finance.category_created",
      "finance_category",
      {
        name: "Meals",
        slug: "meals",
      },
      "Meals",
    ),
  ];
  respond(async () => Response.json({ events: changes, nextCursor: null }));
  const paths: string[] = [];
  ({ container } = await mount(
    <ActivityFeed onNavigate={(path) => paths.push(path)} />,
  ));
  const rows = [...container.querySelectorAll(".activityRow")].map(
    (row) => row.textContent ?? "",
  );
  expect(rows[0]).toContain("Sam started Pro checkout");
  expect(rows[0]).toContain("Pro for 3 seats");
  expect(rows[1]).toContain("deleted a bank's imported data");
  expect(rows[1]).toContain(
    "Deleted 2 accounts, 40 transactions, and 1 annotation",
  );
  expect(rows[2]).toContain("Sam connected a bank");
  expect(rows[3]).toContain("Meals → Team meals");
  expect(rows[4]).toContain("Fuel · 1 transaction left uncategorized");
  expect(rows[5]).toContain("Insurance, Travel");
  expect(rows[6]).toContain("created an expense category");
  // Deleted data has no connection page left to open.
  expect(
    container.querySelectorAll(".activityRow")[1]?.querySelector("button"),
  ).toBeNull();
  await click("Open billing");
  await click("Open connection");
  expect(paths).toEqual([
    "/organization/billing",
    "/finance/connections/finance_connection-1",
  ]);
  expect(
    [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Open categories",
    ),
  ).toHaveLength(4);
});

it("names form publication changes and a copied form's source", async () => {
  const form = (
    id: number,
    action: string,
    details: Record<string, unknown>,
  ): ActivityEvent => ({
    ...event(id, ""),
    action,
    root: { type: "audit_template", id: "form-1", label: "Site walk" },
    subject: { type: "audit_template", id: "form-1" },
    details,
  });
  const changes = [
    form(5, "audit.template_created", {
      copiedFrom: { name: "Ladder check", templateId: "ladder", version: null },
      version: 1,
    }),
    form(4, "audit.template_unpublished", { version: 4 }),
    form(3, "audit.template_version_saved", { version: 3 }),
    form(2, "audit.template_published", { version: 2 }),
    form(1, "audit.template_created", {
      copiedFrom: { name: "NFPA 70E", templateId: "nfpa", version: 5 },
      version: 1,
    }),
  ];
  respond(async () => Response.json({ events: changes, nextCursor: null }));
  ({ container } = await mount(
    <ActivityFeed source={{ type: "audit_template", id: "form-1" }} />,
  ));
  const rows = [...container.querySelectorAll(".activityRow")].map(
    (row) => row.textContent ?? "",
  );
  expect(rows).toHaveLength(5);
  // A copy whose client named no version records only the form.
  expect(rows[0]).toContain("Version 1 · Copied from Ladder check");
  expect(rows[0]).not.toContain("Ladder check, version");
  expect(rows[1]).toContain("Sam unpublished the form");
  expect(rows[1]).toContain("Version 4");
  expect(rows[2]).toContain("Sam saved a form version");
  expect(rows[3]).toContain("Sam published the form");
  expect(rows[4]).toContain("Sam created the form");
  expect(rows[4]).toContain("Version 1 · Copied from NFPA 70E, version 5");
  expect(rows[2]).not.toContain("Copied from");
});

it("shows library, inbox, and business events, linking to records that remain", async () => {
  const recorded = (
    id: number,
    action: string,
    root: ActivityEvent["root"],
    details: ActivityEvent["details"],
  ): ActivityEvent => ({
    ...event(id, ""),
    action,
    details,
    root,
    subject: { id: "email-1", type: "inbound_email" },
  });
  const business = { id: "b1", label: "Acme Holdings", type: "business" };
  respond(async () =>
    Response.json({
      events: [
        recorded(70, "business.updated", business, {
          changes: [
            { after: "Acme Holdings", before: "Acme", field: "name" },
            { after: null, before: "•••4321", field: "ein" },
          ],
        }),
        recorded(
          69,
          "business.deleted",
          { id: "b2", label: "Old Co", type: "business" },
          { duns: null, ein: "•••1111", name: "Old Co" },
        ),
        recorded(
          68,
          "inbox.email_linked",
          { id: "equipment-1", label: "Dell XPS 13", type: "equipment" },
          { from: "sender@example.com", subject: "Lease renewal" },
        ),
        recorded(
          67,
          "inbox.email_restored",
          { id: "email-1", label: "Lease renewal", type: "inbound_email" },
          { from: "sender@example.com", fromStatus: "trash" },
        ),
        recorded(
          66,
          "library.folder_deleted",
          { id: "f1", label: "Taxes", type: "library_folder" },
          { emailLinkCount: 1, fileCount: 2, name: "Taxes" },
        ),
        recorded(
          65,
          "library.file_moved",
          { id: "file-1", label: "w2.pdf", type: "library_file" },
          {
            filename: "w2.pdf",
            fromFolderId: "f1",
            fromFolderName: "Taxes",
            toFolderId: null,
            toFolderName: null,
          },
        ),
      ],
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
    "Sam edited a business · Acme Holdings",
    "Sam deleted a business · Old Co",
    "Sam linked an email · Dell XPS 13",
    "Sam restored an email · Lease renewal",
    "Sam deleted a folder · Taxes",
    "Sam moved a file · w2.pdf",
  ]);
  expect(
    [...container.querySelectorAll("summary")].map(
      (summary) => summary.textContent,
    ),
  ).toEqual([
    "Name: Acme → Acme Holdings · EIN: •••4321 → None",
    "Old Co · EIN •••1111",
    "Lease renewal · Equipment: Dell XPS 13",
    "sender@example.com · from Trash",
    "Taxes · 2 files returned to the library · 1 email link removed",
    "w2.pdf · Taxes → Library (no folder)",
  ]);
  for (const label of ["Old Co", "Taxes", "w2.pdf", "Lease renewal"])
    expect(container.querySelector(`[aria-label$=": ${label}"]`)).toBeNull();
  await click("Acme Holdings");
  await click("Dell XPS 13");
  expect(navigations).toEqual(["/businesses/b1", "/equipment/equipment-1"]);
  const options = [...container.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).toEqual(
    expect.arrayContaining([
      "Library files",
      "Library folders",
      "Inbox",
      "Businesses",
    ]),
  );
});
