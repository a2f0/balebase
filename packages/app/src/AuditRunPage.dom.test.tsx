import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AuditRunPage } from "./AuditRunPage";
import type { AuditDetail } from "./auditApi";

const dom = new Window({ url: "http://localhost:5173/audits/run-1" });
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

function detail(revision: number, response: string): AuditDetail {
  return {
    audit: {
      answerActivity: {},
      completedAt: null,
      createdAt: "2026-10-02T12:00:00.000Z",
      createdBy: { email: "sam@example.com", id: "user-1", name: "Sam" },
      deletedAt: null,
      deletedBy: null,
      definition: {
        sections: [
          {
            id: "section",
            items: [
              {
                id: "check",
                prompt: "Exits clear",
                required: true,
                responseType: "check",
              },
            ],
            title: "Safety",
          },
        ],
        version: 1,
      },
      id: "run-1",
      responses: { check: response },
      revision,
      status: "in_progress",
      templateId: null,
      templateName: "Fire safety",
      templateVersion: 1,
      updatedAt: "2026-10-02T12:00:00.000Z",
    },
    issues: [],
    members: [],
  };
}

describe("audit save conflicts, mounted", () => {
  it("sends the loaded revision, preserves unsaved answers on conflict, and reloads the newer revision", async () => {
    const writes: unknown[] = [];
    let reads = 0;
    globalThis.fetch = (async (input, init) => {
      expect(init?.credentials).toBe("include");
      if (String(input).endsWith("/activity")) {
        return Response.json({ events: [], nextCursor: null });
      }
      if (init?.method === "POST") {
        return Response.json({ issueId: "issue-1" }, { status: 201 });
      }
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return writes.length === 1
          ? Response.json(
              { error: "This audit has changed. Reload it before saving." },
              { status: 409 },
            )
          : Response.json({
              status: "in_progress",
              updatedAt: "2026-10-02T12:01:00.000Z",
            });
      }
      reads += 1;
      return Response.json(
        detail(reads === 1 ? 3 : 4, reads === 1 ? "pass" : "fail"),
      );
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<AuditRunPage id="run-1" onNavigate={() => {}} />),
    );
    await settle();
    await click("N/A");
    expect(container.textContent).toContain("Unsaved answer");
    await click("Save");
    expect(writes[0]).toEqual({
      expectedRevision: 3,
      responses: { check: "na" },
      status: "in_progress",
    });
    expect(reads).toBe(1);
    expect(container.textContent).toContain("This audit has changed");
    expect(
      container.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe("N/A");
    expect(container.textContent).toContain("Unsaved answer");
    await click("Fail");
    await click("Create issue");
    expect(reads).toBe(2);
    expect(container.textContent).toContain("This audit has changed");
    expect(container.textContent).toContain("Unsaved answer");
    await click("Reload audit");
    expect(reads).toBe(3);
    expect(
      container.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe("Fail");
    expect(container.textContent).not.toContain("This audit has changed");
    expect(container.textContent).not.toContain("Unsaved answer");
    await click("Save");
    expect(writes[1]).toEqual({
      expectedRevision: 4,
      responses: { check: "fail" },
      status: "in_progress",
    });
  });
});

describe("discarding an audit, mounted", () => {
  it("asks first, then shows the discarded audit read-only", async () => {
    const requests: string[] = [];
    let discarded = false;
    const navigated: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${new URL(String(input)).pathname}`);
      if (String(input).endsWith("/activity")) {
        return Response.json({ events: [], nextCursor: null });
      }
      if (method === "DELETE") {
        discarded = true;
        return Response.json({ deletedAt: "2026-10-14T12:00:00.000Z" });
      }
      const loaded = detail(2, "pass");
      if (discarded) {
        loaded.audit.deletedAt = "2026-10-14T12:00:00.000Z";
        loaded.audit.deletedBy = {
          email: "alex@example.com",
          id: "user-2",
          name: "Alex",
        };
      }
      return Response.json(loaded);
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <>
          <DialogHost />
          <AuditRunPage
            id="run-1"
            onNavigate={(pathname) => navigated.push(pathname)}
          />
        </>,
      ),
    );
    await settle();
    expect(buttonLabels()).toContain("Save");
    expect(buttonLabels()).not.toContain("Save draft");

    await click("Discard audit");
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Discard “Fire safety”?",
    );
    await answerDialog("Cancel");
    expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual(
      [],
    );

    await click("Discard audit");
    await answerDialog("Discard audit");
    expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([
      "DELETE /api/audits/runs/run-1",
    ]);
    expect(container.textContent).toContain("Audit discarded.");
    expect(container.textContent).toContain(
      "Discarded by Alex · alex@example.com",
    );
    for (const label of ["Save", "Complete audit", "Discard audit"]) {
      expect(buttonLabels()).not.toContain(label);
    }
    const pass = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Pass",
    );
    // Browsers disable every control inside a disabled fieldset.
    const readOnly = container.querySelector<HTMLFieldSetElement>(
      "fieldset.runEditable",
    );
    expect(readOnly?.hasAttribute("disabled")).toBe(true);
    expect(pass && readOnly?.contains(pass)).toBe(true);

    await click("Audits");
    expect(navigated).toEqual(["/audits?view=deleted"]);
  });
});

describe("discarding an audit whose reload fails, mounted", () => {
  it("keeps the page read-only from the discard response alone", async () => {
    let discarded = false;
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/activity")) {
        return Response.json({ events: [], nextCursor: null });
      }
      if (init?.method === "DELETE") {
        discarded = true;
        return Response.json({ deletedAt: "2026-10-14T12:00:00.000Z" });
      }
      return discarded
        ? Response.json({ error: "Temporarily unavailable." }, { status: 503 })
        : Response.json(detail(2, "pass"));
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <>
          <DialogHost />
          <AuditRunPage id="run-1" onNavigate={() => {}} />
        </>,
      ),
    );
    await settle();
    await click("Fail");
    await click("Discard audit");
    await answerDialog("Discard audit");
    expect(container.textContent).toContain("Temporarily unavailable.");
    // The unsaved Fail was never stored; the read-only audit shows the saved Pass.
    expect(
      container.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe("Pass");
    expect(container.textContent).toContain("Discarded ·");
    expect(
      container.querySelector("fieldset.runEditable")?.hasAttribute("disabled"),
    ).toBe(true);
    expect(buttonLabels()).not.toContain("Save");
  });
});

function buttonLabels() {
  return [...container.querySelectorAll("button")].map(
    (element) => element.textContent,
  );
}

/** Answers the open dialog with the button labelled `label`. */
async function answerDialog(label: string) {
  const dialog = document.querySelector("dialog[open]");
  const choice = [...(dialog?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent === label,
  );
  expect(choice).toBeDefined();
  await act(async () => choice?.click());
  await settle();
}
