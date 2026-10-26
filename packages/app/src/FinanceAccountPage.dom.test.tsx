import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { FinanceAccountDetail } from "@balebase/validators/finance";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { FinanceAccountPage } from "./FinanceAccountPage";

const dom = new Window({
  url: "http://localhost:5173/finance/accounts/account-1",
});
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MouseEvent: dom.MouseEvent,
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

const detail: FinanceAccountDetail = {
  account: {
    availableBalance: 1200,
    currencyCode: "USD",
    currentBalance: 1250.5,
    id: "account-1",
    mask: "1234",
    name: "Checking",
    officialName: "Plaid Gold Checking",
    plaidAccountId: "plaid-account-1",
    subtype: "checking",
    transactions: {
      count: 42,
      firstDate: "2025-01-03",
      lastDate: "2026-10-17",
    },
    type: "depository",
    updatedAt: "2026-10-18T12:00:00.000Z",
  },
  connection: {
    dailySync: false,
    id: "item-1",
    institutionId: "ins_109508",
    institutionName: "First Platypus Bank",
    plaidItemId: "plaid-item-1",
    status: "active",
  },
  recentTransactions: [
    {
      amount: 42.75,
      currencyCode: "USD",
      id: "txn-1",
      merchantName: "Test Cafe",
      name: "TEST CAFE 123",
      pending: true,
      transactionDate: "2026-10-17",
    },
    {
      amount: -500,
      currencyCode: "USD",
      id: "txn-2",
      merchantName: null,
      name: "Payroll deposit",
      pending: false,
      transactionDate: "2026-10-15",
    },
  ],
};

async function mount(onNavigate: (path: string) => void = () => undefined) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<FinanceAccountPage id="account-1" onNavigate={onNavigate} />),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function link(href: string) {
  const match = container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  if (!match) throw new Error(`Missing link: ${href}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(
      new dom.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as MouseEvent,
    );
  });
}

describe("Finance account page", () => {
  it("shows the account, its newest transactions, and copyable identifiers", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json(detail);
    }) as typeof fetch;
    const copied: string[] = [];
    Object.defineProperty(dom.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    await mount();

    expect(requests).toEqual([
      expect.stringContaining("/api/finance/accounts/account-1"),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Checking");
    expect(text).toContain("42 transactions · ");
    expect(text).toContain("Plaid Gold Checking");
    expect(link("/finance/connections/item-1").textContent).toBe(
      "First Platypus Bank",
    );
    expect(link("/finance/transactions/txn-1").textContent).toBe("Test Cafe");
    expect(link("/finance/transactions/txn-2").textContent).toBe(
      "Payroll deposit",
    );
    expect(text).toContain("Pending");
    expect(container.querySelector(".financeAmountCredit")?.textContent).toBe(
      "$500.00",
    );

    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy Plaid account ID"]',
    );
    if (!copy) throw new Error("Missing copy button");
    await click(copy);
    expect(copied).toEqual(["plaid-account-1"]);
  });

  it("opens the account's connection and transactions in the app", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json(detail)) as typeof fetch;
    const paths: string[] = [];
    await mount((path) => paths.push(path));

    await click(link("/finance/transactions/txn-1"));
    await click(link("/finance/connections/item-1"));
    const view = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "View connection",
    );
    if (!view) throw new Error("Missing View connection");
    await click(view);
    expect(paths).toEqual([
      "/finance/transactions/txn-1",
      "/finance/connections/item-1",
      "/finance/connections/item-1",
    ]);
  });

  it("reports an account that cannot be loaded", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json(
        { error: "Account not found." },
        { status: 404 },
      )) as typeof fetch;
    await mount();
    expect(container.textContent).toContain("Account not found.");
    expect(container.textContent).not.toContain("Loading account");
  });
});
