import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type {
  AuditTemplate,
  AuditTemplateScope,
} from "@balebase/validators/audits";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AuditHome } from "./AuditHome";

// Mounts the real page in happy-dom so the layout switch renders and the
// choice round-trips through the page's own storage.
const dom = new Window({ url: "http://localhost:5173/audits" });
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

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  // React DOM decides whether it can use the DOM when first loaded.
  ({ createRoot } = await import("react-dom/client"));
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

const mounted: { container: HTMLElement; root: Root }[] = [];

afterEach(async () => {
  for (const { container, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  dom.localStorage.clear();
  globalThis.fetch = originalFetch;
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
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/audits/templates")) {
      return Response.json({ templates });
    }
    return Response.json({ audits: [], nextCursor: null });
  }) as typeof fetch;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(<AuditHome onNavigate={() => {}} />));
  await settle();
  return page(container);
}

function page(container: HTMLElement) {
  const layoutButton = (label: string) =>
    [...container.querySelectorAll(".segmented > button")].find(
      (element) => element.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
  return {
    cards: () => container.querySelectorAll(".auditTemplateCard").length,
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

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

const templates = [
  template("g1", "Fire safety", "global"),
  template("o1", "Kitchen close", "organization"),
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
      expect(text).toContain("Start audit");
    }
    expect(globalRow).toContain("Fire safety");
    expect(globalRow).toContain("Customize");
    expect(organizationRow).toContain("Kitchen close");
    expect(organizationRow).toContain("Edit");
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
    for (const { container, root } of mounted.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }

    const second = await mountPage();
    expect(second.pressed()).toEqual(["List"]);
    expect(second.rowText()).toHaveLength(2);

    await click(second.layoutButton("Grid"));
    expect(second.cards()).toBe(2);
  });
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
      responseCount: 1,
      status: "in_progress",
      templateName: "Kitchen close",
      templateVersion: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
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
                templateName: "Fire safety",
              },
            ]
          : [run];
      return Response.json({ audits, nextCursor: null });
    }) as typeof fetch;

    try {
      const view = await mountPage();
      expect(view.text()).toContain("Recent audits");
      expect(view.text()).toContain("Kitchen close");
      await click(view.layoutButton("Deleted"));
      expect(requested).toEqual([
        "/api/audits/runs",
        "/api/audits/runs?view=deleted",
      ]);
      expect(view.text()).toContain("Deleted audits");
      expect(view.text()).toContain("Discarded");
      expect(view.text()).toContain("by Alex");
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
      responseCount: 0,
      status: "in_progress",
      templateName: id,
      templateVersion: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    let releaseStalePage: (() => void) | undefined;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
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
    }) as typeof fetch;

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
