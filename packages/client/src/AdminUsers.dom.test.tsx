import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AdminUsers } from "./AdminUsers";

const dom = new Window({ url: "http://localhost:5173/root/users" });
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

function user(email: string, lastActiveAt: string | null) {
  return {
    banned: false,
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
    expect(headers.at(-1)).toBe("Last active");
    const lastActive = (email: string) =>
      [...container.querySelectorAll("tr")].find((row) =>
        row.textContent?.includes(email),
      )?.lastElementChild?.textContent;
    expect(lastActive("active@example.com")).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date("2026-10-14T15:30:00.000Z"),
      ),
    );
    expect(lastActive("dormant@example.com")).toBe("Never");
  });
});
