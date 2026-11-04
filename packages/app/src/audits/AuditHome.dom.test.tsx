import { afterEach, describe, expect, it } from "bun:test";
import type {
  AuditTemplate,
  AuditTemplateScope,
} from "@balebase/validators/audits";
import { act } from "react";
import { installDom } from "../testing/dom";
import { AuditHome } from "./AuditHome";

// Mounts the real page in happy-dom so the layout switch renders and the
// choice round-trips through the page's own storage.
const {
  click,
  mount,
  respond,
  settle,
  window: dom,
} = installDom({ url: "http://localhost:5173/audits" });

afterEach(() => {
  dom.localStorage.clear();
});

function template(
  id: string,
  name: string,
  scope: AuditTemplateScope,
): AuditTemplate {
  const actor = { email: "owner@example.com", id: "u1", name: "Owner" };
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    currentVersion: 2,
    definition: {
      sections: [
        {
          id: "s1",
          items: [
            {
              id: "i1",
              prompt: "Exits clear",
              required: true,
              responseType: "check",
            },
            {
              id: "i2",
              prompt: "Notes",
              required: false,
              responseType: "text",
            },
          ],
          title: "Safety",
        },
      ],
      version: 1,
    },
    description: `${name} checklist.`,
    id,
    name,
    savedAt: "2026-09-01T00:00:00.000Z",
    savedBy: actor,
    scope,
    status: "published",
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 2,
  };
}

function stubApi(templates: AuditTemplate[]) {
  respond(async ({ href: url }) => {
    if (url.endsWith("/api/audits/templates")) {
      return Response.json({ templates });
    }
    return Response.json({ audits: [], nextCursor: null });
  });
}

async function mountPage() {
  const { container, unmount } = await mount(
    <AuditHome onNavigate={() => {}} />,
  );
  await settle();
  return { ...page(container), unmount };
}

function page(container: HTMLElement) {
  const layoutButton = (label: string) =>
    [...container.querySelectorAll(".segmented > button")].find(
      (element) => element.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
  return {
    cards: () => container.querySelectorAll(".auditTemplateCard").length,
    menuButtons: () =>
      [...container.querySelectorAll('[aria-haspopup="menu"]')].map((element) =>
        element.getAttribute("aria-label"),
      ),
    layoutButton,
    pressed: () =>
      [
        ...container.querySelectorAll(
          '.auditTemplateToolbar .segmented > [aria-pressed="true"]',
        ),
      ].map((element) => element.textContent?.trim()),
    rowText: () =>
      [...container.querySelectorAll(".auditTemplateRow")].map(
        (element) => element.textContent ?? "",
      ),
    text: () => container.textContent ?? "",
  };
}

const templates = [
  { ...template("g1", "Fire safety", "global"), auditCount: 4 },
  { ...template("o1", "Kitchen close", "organization"), auditCount: 1 },
];

describe("audit template layout, mounted", () => {
  it("starts on the grid of cards", async () => {
    stubApi(templates);
    const view = await mountPage();
    expect(view.pressed()).toEqual(["Grid"]);
    expect(view.cards()).toBe(2);
    expect(view.rowText()).toEqual([]);
  });

  it("switches to rows that keep each template's details and actions", async () => {
    stubApi(templates);
    const view = await mountPage();
    await click(view.layoutButton("List"));

    expect(view.pressed()).toEqual(["List"]);
    expect(view.cards()).toBe(0);
    const [globalRow, organizationRow] = view.rowText();
    for (const text of [globalRow, organizationRow]) {
      expect(text).toContain("Published");
      expect(text).toContain("2 items");
      expect(text).toContain("1 section");
      expect(text).toContain("v2");
      // Audits start from a project, never from the library.
      expect(text).not.toContain("Start audit");
    }
    expect(globalRow).toContain("Fire safety");
    expect(globalRow).toContain("4 audits");
    expect(organizationRow).toContain("Kitchen close");
    expect(organizationRow).toContain("1 audit");
    expect(organizationRow).not.toContain("1 audits");
    // Each row's actions are in its menu, not buttons of their own.
    expect(view.menuButtons()).toEqual([
      "Actions for Fire safety",
      "Actions for Kitchen close",
    ]);
    for (const text of [globalRow, organizationRow]) {
      expect(text).not.toContain("Manage");
    }
  });

  it("leaves global form management to Global Audits", async () => {
    stubApi(templates);
    const view = await mountPage();
    expect(view.text()).toContain("New organization checklist");
    expect(view.text()).toContain("Global forms");
    expect(view.text()).not.toContain("New global checklist");
    expect(view.text()).not.toContain("Manage global");
  });

  it("remembers the chosen layout on the next visit", async () => {
    stubApi(templates);
    const first = await mountPage();
    await click(first.layoutButton("List"));
    await first.unmount();

    const second = await mountPage();
    expect(second.pressed()).toEqual(["List"]);
    expect(second.rowText()).toHaveLength(2);

    await click(second.layoutButton("Grid"));
    expect(second.cards()).toBe(2);
  });
});

const menuItems = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
    (item) => item.textContent,
  );

describe("a form's menu, mounted", () => {
  for (const [opening, open] of [
    [
      "its menu button",
      async (card: Element) =>
        click(card.querySelector<HTMLElement>('[aria-haspopup="menu"]')),
    ],
    [
      "a right-click on its card",
      async (card: Element) => {
        const event = new dom.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: 100,
          clientY: 100,
        });
        await act(async () => card.dispatchEvent(event as never));
      },
    ],
  ] as const) {
    it(`assigns projects or customizes a form from ${opening}`, async () => {
      stubApi(templates);
      const visited: string[] = [];
      const { container } = await mount(
        <AuditHome onNavigate={(pathname) => visited.push(pathname)} />,
      );
      await settle();
      const [global, organization] =
        container.querySelectorAll(".auditTemplateCard");
      if (!global || !organization) throw new Error("Missing cards.");
      await open(global);
      expect(menuItems()).toEqual(["Assign projects", "Customize"]);
      await click(
        document.querySelector<HTMLButtonElement>('[role="menuitem"]'),
      );
      await open(organization);
      expect(menuItems()).toEqual(["Assign projects", "Edit"]);
      await click(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1],
      );
      expect(visited).toEqual([
        "/audits/templates/g1?tab=projects",
        "/audits/templates/o1",
      ]);
    });
  }
});

describe("deleted audits, mounted", () => {
  it("lists discarded audits, and opens them from a one-time deep link", async () => {
    const requested: string[] = [];
    const actor = { email: "alex@example.com", id: "u2", name: "Alex" };
    const run = {
      completedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: actor,
      deletedAt: null,
      deletedBy: null,
      id: "run-active",
      issueCount: 0,
      project: { deleted: false, id: "p1", name: "Riverside clinic" },
      responseCount: 1,
      status: "in_progress",
      templateName: "Kitchen close",
      templateVersion: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    respond(async (url) => {
      if (url.pathname.endsWith("/api/audits/templates")) {
        return Response.json({ templates });
      }
      requested.push(`${url.pathname}${url.search}`);
      const audits =
        url.searchParams.get("view") === "deleted"
          ? [
              {
                ...run,
                deletedAt: "2026-10-14T12:00:00.000Z",
                deletedBy: actor,
                id: "run-discarded",
                project: { deleted: true, id: "p2", name: "Old site" },
                templateName: "Fire safety",
              },
            ]
          : [run];
      return Response.json({ audits, nextCursor: null });
    });

    try {
      const view = await mountPage();
      expect(view.text()).toContain("Recent audits");
      expect(view.text()).toContain("Kitchen close");
      // Each audit names the project it belongs to.
      expect(view.text()).toContain("Riverside clinic ·");
      await click(view.layoutButton("Deleted"));
      expect(requested).toEqual([
        "/api/audits/runs",
        "/api/audits/runs?view=deleted",
      ]);
      expect(view.text()).toContain("Deleted audits");
      expect(view.text()).toContain("Discarded");
      expect(view.text()).toContain("by Alex");
      expect(view.text()).toContain("Old site (deleted project)");
      expect(window.location.search).toBe("");

      // Back from a discarded audit opens the deleted list, then the address
      // returns to /audits so later navigation there shows active audits.
      window.history.replaceState(null, "", "/audits?view=deleted");
      const revisited = await mountPage();
      expect(
        revisited.layoutButton("Deleted")?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(requested.at(-1)).toBe("/api/audits/runs?view=deleted");
      expect(window.location.search).toBe("");
    } finally {
      window.history.replaceState(null, "", "/audits");
    }
  });

  it("drops a page that arrives after the list changed and changed back", async () => {
    const actor = { email: "alex@example.com", id: "u2", name: "Alex" };
    const run = (id: string) => ({
      completedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: actor,
      deletedAt: null,
      deletedBy: null,
      id,
      issueCount: 0,
      project: { deleted: false, id: "p1", name: "Riverside clinic" },
      responseCount: 0,
      status: "in_progress",
      templateName: id,
      templateVersion: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    let releaseStalePage: (() => void) | undefined;
    respond(async (url) => {
      if (url.pathname.endsWith("/api/audits/templates")) {
        return Response.json({ templates });
      }
      if (url.searchParams.get("cursor") === "page-2") {
        await new Promise<void>((resolve) => {
          releaseStalePage = resolve;
        });
        return Response.json({ audits: [run("Stale")], nextCursor: null });
      }
      return Response.json({
        audits:
          url.searchParams.get("view") === "deleted" ? [] : [run("Fresh")],
        nextCursor: "page-2",
      });
    });

    const view = await mountPage();
    const loadMore = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "Load more audits",
    );
    await act(async () => loadMore?.click());
    await click(view.layoutButton("Deleted"));
    await click(view.layoutButton("Active"));
    // The obsolete request no longer holds the fresh list's Load more busy.
    const freshLoadMore = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "Load more audits",
    );
    expect(freshLoadMore?.getAttribute("aria-busy")).toBeNull();
    await act(async () => releaseStalePage?.());
    await settle();
    expect(view.text()).toContain("Fresh");
    expect(view.text()).not.toContain("Stale");
  });
});
