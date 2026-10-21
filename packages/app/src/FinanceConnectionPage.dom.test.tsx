import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { FinanceConnectionPage } from "./FinanceConnectionPage";
import type { FinanceConnectionDetail } from "./financeApi";

const dom = new Window({
  url: "http://localhost:5173/finance/connections/item-1",
});
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
  Reflect.deleteProperty(dom.navigator, "clipboard");
});
afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function detail(
  connection: Partial<FinanceConnectionDetail["connection"]> = {},
): FinanceConnectionDetail {
  return {
    accounts: [
      {
        availableBalance: 1200,
        currencyCode: "USD",
        currentBalance: 1250.5,
        id: "account-1",
        mask: "1234",
        name: "Checking",
        officialName: "Plaid Gold Checking",
        plaidAccountId: "plaid-account-1",
        subtype: "checking",
        transactionCount: 42,
        type: "depository",
      },
    ],
    connection: {
      createdAt: "2026-09-01T12:00:00.000Z",
      createdBy: { email: "person@example.com", name: "Example Person" },
      disconnectedAt: null,
      errorCode: null,
      errorMessage: null,
      id: "item-1",
      institutionId: "ins_109508",
      institutionName: "First Platypus Bank",
      lastSyncedAt: "2026-10-18T12:00:00.000Z",
      plaidItemId: "plaid-item-1",
      status: "active",
      transactions: {
        count: 42,
        firstDate: "2025-01-03",
        lastDate: "2026-10-17",
      },
      ...connection,
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(onNavigate: (path: string) => void = () => undefined) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <FinanceConnectionPage id="item-1" onNavigate={onNavigate} />
        <DialogHost />
      </>,
    ),
  );
  await settle();
}

function button(label: string, scope: ParentNode = container) {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
  await settle();
}

/** Answers the open dialog with the button labelled `label`. */
async function answer(label: string) {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("No open dialog");
  await click(label, dialog);
}

describe("Finance connection page", () => {
  it("shows the connection, its accounts, and copyable Plaid identifiers", async () => {
    const copied: string[] = [];
    Object.defineProperty(dom.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json(detail());
    }) as typeof fetch;
    await mount();

    expect(requests).toEqual([
      expect.stringContaining("/api/finance/connections/item-1"),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("First Platypus Bank");
    expect(text).toContain("by Example Person");
    expect(text).toContain("42 transactions");
    expect(text).toContain("Plaid Gold Checking");
    expect(text).toContain("plaid-item-1");
    expect(text).not.toContain("Last error");
    expect(text).toContain("42 transactions · ");
    const account = container.querySelector<HTMLAnchorElement>(
      ".rowTarget[href='/finance/accounts/account-1']",
    );
    expect(account?.textContent).toBe("Checking");
    await click("Copy Plaid Item ID");
    await click("Copy Plaid account ID · Checking ••1234");
    await click("Copy Plaid institution ID");
    expect(copied).toEqual(["plaid-item-1", "plaid-account-1", "ins_109508"]);
    expect(document.body.textContent).toContain("Plaid institution ID copied.");
    expect(() => button("Copy Institution")).toThrow();
  });

  it("reloads after a failed sync to show Plaid's error", async () => {
    let failed = false;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "POST") {
        failed = true;
        return Response.json(
          {
            code: "ITEM_LOGIN_REQUIRED",
            error: "The login details of this item have changed.",
          },
          { status: 502 },
        );
      }
      return Response.json(
        failed
          ? detail({
              errorCode: "ITEM_LOGIN_REQUIRED",
              errorMessage: "The login details of this item have changed.",
              status: "error",
            })
          : detail(),
      );
    }) as typeof fetch;
    await mount();
    await click("Sync now");
    const text = container.textContent ?? "";
    expect(text).toContain("The login details of this item have changed.");
    expect(text).toContain("Last error");
    expect(text).toContain("ITEM_LOGIN_REQUIRED");
    expect(button("Sync now").disabled).toBe(false);
  });

  it("deletes a disconnected connection's data and returns to Connections", async () => {
    const deletes: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "DELETE") {
        deletes.push(String(input));
        return new Response(null, { status: 204 });
      }
      return Response.json(
        detail({
          disconnectedAt: "2026-10-19T09:00:00.000Z",
          status: "disconnected",
        }),
      );
    }) as typeof fetch;
    const paths: string[] = [];
    await mount((path) => paths.push(path));
    expect(() => button("Sync now")).toThrow();
    expect(container.textContent).toContain("Disconnected");

    await click("Delete data");
    await answer("Cancel");
    expect(deletes).toEqual([]);
    await click("Delete data");
    await answer("Delete data");
    expect(deletes).toEqual([
      expect.stringContaining("/api/finance/connections/item-1/data"),
    ]);
    expect(paths).toEqual(["/finance/connections"]);
  });
});
