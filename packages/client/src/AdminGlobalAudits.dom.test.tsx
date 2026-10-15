import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AuditTemplate } from "./auditApi";
import { apiUrl } from "./config";

const dom = new Window({ url: "http://localhost:5173/root/global-audits" });
const domGlobals = {
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let AdminGlobalAudits: typeof import("./AdminGlobalAudits").AdminGlobalAudits;
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
  ({ AdminGlobalAudits } = await import("./AdminGlobalAudits"));
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

const globalForm: AuditTemplate = {
  createdAt: "2026-10-01T09:00:00.000Z",
  currentVersion: 1,
  definition: {
    sections: [
      {
        id: "s1",
        items: [
          {
            id: "q1",
            prompt: "Exits clear",
            required: true,
            responseType: "check",
          },
        ],
        title: "Exits",
      },
    ],
    version: 1,
  },
  description: "Shared with every organization.",
  id: "fire/safety",
  name: "Fire safety",
  savedAt: "2026-10-01T09:00:00.000Z",
  savedBy: { email: "root@example.com", id: "u1", name: "Root" },
  scope: "global",
  status: "published",
  updatedAt: "2026-10-01T09:00:00.000Z",
  version: 1,
};

const admin = `${apiUrl}/api/admin/audit-templates`;

/** Answers like the root admin API, recording every request. */
function stubApi(form = globalForm, failure?: string) {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "DELETE") {
      return failure
        ? Response.json({ error: failure }, { status: 409 })
        : Response.json({ discarded: true });
    }
    if (method === "POST") {
      return Response.json(
        { template: { ...globalForm, id: "new/form" } },
        { status: 201 },
      );
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      return Response.json({
        template: { ...form, ...body, currentVersion: 2, version: 2 },
      });
    }
    if (url === admin) return Response.json({ templates: [globalForm] });
    if (url.endsWith("/versions")) return Response.json({ versions: [] });
    if (url.includes("/activity")) {
      return Response.json({ events: [], nextCursor: null });
    }
    return Response.json({ template: form });
  }) as typeof fetch;
  return requests;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function render(pathname: string) {
  const paths: string[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <AdminGlobalAudits
          onNavigate={(path) => paths.push(path)}
          pathname={pathname}
        />
        <DialogHost />
      </>,
    ),
  );
  await settle();
  return paths;
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button labeled ${text}`);
  return found;
}

describe("Global Audits", () => {
  it("unpublishes and republishes a form without offering deletion", async () => {
    const requests = stubApi();
    await render("/root/global-audits/fire%2Fsafety");
    expect(container.textContent).not.toContain("Discard draft");
    await act(async () => button("Unpublish").click());
    await settle();
    expect(container.textContent).toContain("Form unpublished.");
    expect(container.textContent).not.toContain("Discard draft");
    await act(async () => button("Publish").click());
    await settle();
    expect(container.textContent).toContain("Form published.");
    expect(
      requests.filter((request) => request.startsWith("PUT")),
    ).toHaveLength(2);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
      false,
    );
  });

  it("confirms discarding a draft and returns to Global Audits", async () => {
    const requests = stubApi({ ...globalForm, status: "draft" });
    const paths = await render("/root/global-audits/fire%2Fsafety");
    await act(async () => button("Discard draft").click());
    await act(async () => button("Cancel").click());
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
      false,
    );
    await act(async () => button("Discard draft").click());
    const confirm = document.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] .buttonDanger',
    );
    expect(confirm).not.toBeNull();
    await act(async () => confirm?.click());
    await settle();
    expect(requests).toContain(`DELETE ${admin}/fire%2Fsafety`);
    expect(paths).toEqual(["/root/global-audits"]);
  });

  it("keeps a draft open when discarding fails", async () => {
    stubApi(
      { ...globalForm, status: "draft" },
      "This template has a newer version. Reload it before saving.",
    );
    const paths = await render("/root/global-audits/fire%2Fsafety");
    await act(async () => button("Discard draft").click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="alertdialog"] .buttonDanger')
        ?.click(),
    );
    await settle();
    expect(paths).toEqual([]);
    expect(container.textContent).toContain(
      "This template has a newer version.",
    );
  });

  it("lists global forms from the root admin API and opens one to manage", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits");

    expect(container.querySelector("h1")?.textContent).toBe("Global Audits");
    const row = container.querySelector(".auditTemplateRow");
    expect(row?.textContent).toContain("Fire safety");
    expect(row?.textContent).not.toContain("Start audit");
    const manage = row?.querySelector<HTMLAnchorElement>("a");
    expect(manage?.textContent).toBe("Manage");
    expect(manage?.getAttribute("href")).toBe(
      "/root/global-audits/fire%2Fsafety",
    );
    await act(async () => manage?.click());
    expect(paths).toEqual(["/root/global-audits/fire%2Fsafety"]);
    expect(requests).toEqual([`GET ${admin}`]);
  });

  it("creates new global checklists through the root admin API", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits");

    await act(async () => button("New global checklist").click());
    await settle();
    expect(requests).toEqual([`GET ${admin}`, `POST ${admin}`]);
    expect(paths).toEqual(["/root/global-audits/new%2Fform"]);
  });

  it("edits a global form without going through the active organization", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits/fire%2Fsafety");

    expect(container.textContent).toContain(
      "You are managing the shared global form",
    );
    await act(async () => button("Save as version 2").click());
    await settle();
    expect(container.textContent).toContain("Version 2 saved.");
    expect(requests).toContain(`PUT ${admin}/fire%2Fsafety`);
    expect(requests).toContain(`GET ${admin}/fire%2Fsafety/activity`);
    expect(
      requests.filter((request) => request.includes("/api/audits")),
    ).toEqual([]);

    await act(async () => button("Global Audits").click());
    expect(paths).toEqual(["/root/global-audits"]);
  });
});
