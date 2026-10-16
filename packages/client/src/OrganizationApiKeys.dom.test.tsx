import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiKey } from "./apiKeysApi";

const dom = new Window({ url: "http://localhost:5173/organization/api-keys" });
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
const copied: string[] = [];
let createRoot: (container: Element) => Root;
let OrganizationApiKeys: typeof import("./OrganizationApiKeys").OrganizationApiKeys;
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
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  ({ createRoot } = await import("react-dom/client"));
  ({ OrganizationApiKeys } = await import("./OrganizationApiKeys"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
  copied.length = 0;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function apiKey(overrides: Partial<ApiKey>): ApiKey {
  return {
    access: "read",
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: { email: "olivia@example.com", id: "user-1", name: "Olivia" },
    expiresAt: "2099-01-01T00:00:00.000Z",
    id: "key-1",
    lastUsedAt: null,
    name: "Reporting",
    prefix: "tlk_1234abcd",
    revokedAt: null,
    revokedBy: null,
    status: "active",
    ...overrides,
  };
}

const token = `tlk_${"a".repeat(64)}`;

/** Serves the key list and records writes. */
function stubApi(initial: ApiKey[], options: { failList?: boolean } = {}) {
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  let keys = [...initial];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (options.failList) {
        return Response.json(
          { error: "Keys are unavailable." },
          { status: 500 },
        );
      }
      return Response.json({ apiKeys: keys });
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, method, path: url.pathname });
    if (method === "POST") {
      const created = apiKey({ access: "write", id: "key-2", name: "Claude" });
      keys = [created, ...keys];
      return Response.json({ apiKey: created, token }, { status: 201 });
    }
    const revoked = {
      ...(keys.find(({ id }) => url.pathname.endsWith(id)) ?? apiKey({})),
      revokedAt: "2026-10-16T09:00:00.000Z",
      revokedBy: { email: "olivia@example.com", id: "user-1", name: "Olivia" },
      status: "revoked" as const,
    };
    return Response.json({ apiKey: revoked });
  }) as typeof fetch;
  return requests;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <OrganizationApiKeys organizationId="org-1" />
        <DialogHost />
      </>,
    ),
  );
  await settle();
}

const button = (scope: ParentNode | null | undefined, label: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  ) ?? null;

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

async function change(
  element: HTMLInputElement | HTMLSelectElement | null,
  value: string,
) {
  expect(element).toBeTruthy();
  await act(async () => {
    if (!element) return;
    const prototype =
      element instanceof dom.HTMLSelectElement
        ? dom.HTMLSelectElement.prototype
        : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.Event("change", { bubbles: true }) as never);
    element.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

describe("organization API keys", () => {
  it("lists keys with their access, prefix, and usage", async () => {
    stubApi([
      apiKey({ lastUsedAt: "2026-10-15T12:00:00.000Z" }),
      apiKey({
        access: "write",
        id: "key-old",
        name: "Old",
        status: "inactive",
      }),
    ]);
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("1 active key");
    expect(text).toContain("Reporting");
    expect(text).toContain("Read only");
    expect(text).toContain("tlk_1234abcd…");
    expect(text).toContain("Created by Olivia");
    expect(text).toContain("Last used");
    expect(text).toContain("Inactive");
    expect(text).toContain("Read and write");
    expect(text).toContain("http://localhost:8787/mcp");
  });

  it("creates a key, shows it once, and returns to the form", async () => {
    const requests = stubApi([]);
    await render();
    expect(container.textContent).toContain("No API keys yet");

    await change(container.querySelector('input[type="text"]'), " Claude ");
    const [access, expiration] = [...container.querySelectorAll("select")];
    await change(access ?? null, "write");
    await change(expiration ?? null, "never");
    await click(button(container, "Create API key"));

    expect(requests).toEqual([
      {
        body: { access: "write", expiresInDays: null, name: "Claude" },
        method: "POST",
        path: "/api/organization-settings/api-keys",
      },
    ]);
    const secret = container.querySelector<HTMLInputElement>(
      'input[aria-label="API key"]',
    );
    expect(secret?.value).toBe(token);
    expect(container.textContent).toContain(
      `claude mcp add --transport http balebase http://localhost:8787/mcp --header "Authorization: Bearer ${token}"`,
    );
    await click(button(container, "Copy key"));
    expect(copied).toEqual([token]);
    expect(container.textContent).toContain("API key copied.");

    await click(button(container, "Done"));
    expect(container.querySelector('input[aria-label="API key"]')).toBeNull();
    expect(container.textContent).not.toContain(token);
    expect(button(container, "Create API key")).toBeTruthy();
    expect(container.textContent).toContain("1 active key");
  });

  it("revokes a key after confirmation", async () => {
    const requests = stubApi([apiKey({})]);
    await render();

    await click(button(container, "Revoke"));
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Revoke Reporting?",
    );
    await click(button(document.querySelector("dialog[open]"), "Revoke key"));
    expect(requests).toEqual([
      {
        body: null,
        method: "DELETE",
        path: "/api/organization-settings/api-keys/key-1",
      },
    ]);
    expect(container.textContent).toContain("Revoked");
    expect(container.textContent).toContain("0 active keys");
    expect(button(container, "Revoke")).toBeNull();
  });

  it("offers a retry when keys cannot be loaded", async () => {
    stubApi([], { failList: true });
    await render();
    expect(container.textContent).toContain("Keys are unavailable.");
    expect(button(container, "Try again")).toBeTruthy();
  });
});
