import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AdminUsers } from "./AdminUsers";

const dom = new Window({ url: "http://localhost:5173/root/users" });
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

function user(email: string, lastActiveAt: string | null) {
  return {
    banned: false,
    deletionRequestedAt: null as string | null,
    deletionRequestedByName: null as string | null,
    deletionRequestedByEmail: null as string | null,
    createdAt: "2026-09-01T09:00:00.000Z",
    email,
    emailVerified: true,
    id: email,
    lastActiveAt,
    name: email.split("@")[0],
    role: "user",
  };
}

describe("root admin users", () => {
  it("shows when each account was last active", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        limit: 25,
        offset: 0,
        total: 2,
        users: [
          user("active@example.com", "2026-10-14T15:30:00.000Z"),
          user("dormant@example.com", null),
        ],
      })) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AdminUsers />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const headers = [...container.querySelectorAll("th")].map(
      (header) => header.textContent,
    );
    expect(headers[4]).toBe("Last active");
    const lastActive = (email: string) =>
      [...container.querySelectorAll("tr")].find((row) =>
        row.textContent?.includes(email),
      )?.children[4]?.textContent;
    expect(lastActive("active@example.com")).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date("2026-10-14T15:30:00.000Z"),
      ),
    );
    expect(lastActive("dormant@example.com")).toBe("Never");
  });
});

async function renderUsers() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <AdminUsers />
        <DialogHost />
      </>,
    ),
  );
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

async function openUserAction(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  expect(document.querySelector('[role="menu"]')).toBeTruthy();
  await act(async () => button(label).click());
}

async function typeEmail(email: string) {
  const input = document.querySelector<HTMLInputElement>("dialog input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, email);
    input?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

it("requires email confirmation, refreshes pending status, and confirms cancellation", async () => {
  const target = user("target@example.com", null);
  const mutations: Array<{ method: string; body: unknown; path: string }> = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST" || init?.method === "DELETE") {
      mutations.push({
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : null,
        path: new URL(String(input)).pathname,
      });
      target.deletionRequestedAt = init.method === "POST" ? "2026-10-26" : null;
      target.deletionRequestedByEmail = "admin@example.com";
      return Response.json(
        init.method === "POST"
          ? { requestedAt: target.deletionRequestedAt }
          : { ok: true },
      );
    }
    return Response.json({ total: 1, users: [target] });
  }) as typeof fetch;
  await renderUsers();
  expect(container.textContent).not.toContain("Mark for deletion");
  await openUserAction("Mark for deletion");
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "Mark target@example.com for deletion?",
  );
  expect(button("Mark for deletion").disabled).toBeTrue();
  await typeEmail("wrong@example.com");
  expect(button("Mark for deletion").disabled).toBeTrue();
  await act(async () => button("Cancel").click());
  expect(mutations).toEqual([]);
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(mutations).toEqual([
    {
      method: "POST",
      body: { confirm: target.email },
      path: "/api/admin/users/target%40example.com/deletion",
    },
  ]);
  expect(container.textContent).toContain("Pending deletion");
  expect(container.textContent).toContain("Marked by admin@example.com");
  await openUserAction("Cancel deletion");
  await act(async () => button("Keep request").click());
  expect(mutations).toHaveLength(1);
  await openUserAction("Cancel deletion");
  await act(async () => button("Cancel deletion").click());
  expect(mutations.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
  expect(container.textContent).not.toContain("Pending deletion");
});

it("disables marking admin accounts", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      total: 1,
      users: [{ ...user("admin@example.com", null), role: "user, admin" }],
    })) as unknown as typeof fetch;
  await renderUsers();
  expect(
    container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
      ?.disabled,
  ).toBeTrue();
});

it("shows failed requests without changing deletion status", async () => {
  const target = user("target@example.com", null);
  globalThis.fetch = (async (_input, init) =>
    init?.method === "POST"
      ? Response.json({ error: "Could not mark user." }, { status: 500 })
      : Response.json({ total: 1, users: [target] })) as typeof fetch;
  await renderUsers();
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(container.textContent).toContain("Could not mark user.");
  expect(container.textContent).not.toContain("Pending deletion");
  expect(
    container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
      ?.disabled,
  ).toBeFalse();
});
