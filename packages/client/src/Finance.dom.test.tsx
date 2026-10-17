import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Finance } from "./Finance";
import type { FinanceData, FinanceTransaction } from "./financeApi";

const dom = new Window({ url: "http://localhost:5173/finance" });
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;
const year = new Date().getFullYear();
const account = (id: string, name: string) => ({
  availableBalance: null,
  currencyCode: "USD",
  currentBalance: 100,
  id,
  institutionName: "Bank",
  mask: null,
  name,
  officialName: null,
  subtype: "checking",
  type: "depository",
});
const transaction = (
  id: string,
  overrides: Partial<FinanceTransaction> = {},
): FinanceTransaction => ({
  accountId: "checking",
  accountName: "Checking",
  amount: 10,
  annotation: { labels: [], note: "", reviewed: false },
  authorizedDate: null,
  categoryDetailed: null,
  categoryPrimary: "FOOD_AND_DRINK",
  currencyCode: "USD",
  expenseCategoryId: null,
  id,
  linkedEmails: [],
  merchantName: null,
  name: id,
  paymentChannel: null,
  pending: false,
  transactionDate: `${year}-01-01`,
  ...overrides,
});
const data: FinanceData = {
  accounts: [
    account("checking", "Checking"),
    account("savings", "Savings"),
    account("card", "Card"),
  ],
  categories: [{ id: "meals", name: "Meals", transactionCount: 0 }],
  configured: true,
  connections: [],
  nextCursor: null,
  transactions: [
    transaction("Coffee"),
    transaction("Supplies", { accountId: "savings" }),
  ],
};

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  })) {
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

function respond(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(new URL(input.toString()), init))) as typeof fetch;
}
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<Finance onNavigate={() => undefined} pathname="/finance" />),
  );
}
function button(label: string) {
  const match = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) =>
    item.matches(".financeAccount")
      ? item.querySelector(".financeAccountName")?.textContent === label
      : item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
async function click(label: string, shiftKey = false) {
  await act(async () => {
    button(label).dispatchEvent(
      new dom.MouseEvent("click", {
        bubbles: true,
        shiftKey,
      }) as unknown as MouseEvent,
    );
  });
}
function rowNames() {
  return [...container.querySelectorAll(".financeTransactionName")].map(
    (row) => row.textContent,
  );
}
function selectedAccounts() {
  return [
    ...container.querySelectorAll(
      '.financeAccount[aria-pressed="true"] .financeAccountName',
    ),
  ].map((node) => node.textContent);
}

describe("Finance filters", () => {
  it("combines Shift account toggles, year shortcuts, and uncategorized expenses, then clears them", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json(data);
    });
    await mount();
    await click("Checking");
    expect(selectedAccounts()).toEqual(["Checking"]);
    await click("Savings", true);
    expect(selectedAccounts()).toEqual(["Checking", "Savings"]);
    await click("Current year");
    await click("Uncategorized expenses");
    expect(queries.at(-1)?.getAll("accountId")).toEqual([
      "checking",
      "savings",
    ]);
    expect(queries.at(-1)?.get("year")).toBe(String(year));
    expect(queries.at(-1)?.get("uncategorized")).toBe("true");
    await click("Checking", true);
    expect(selectedAccounts()).toEqual(["Savings"]);
    await click("Previous year");
    expect(queries.at(-1)?.get("year")).toBe(String(year - 1));
    expect(button("Current year").getAttribute("aria-pressed")).toBe("false");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
    await click("All accounts");
    expect(queries.at(-1)?.getAll("accountId")).toEqual([]);
    expect(queries.at(-1)?.get("year")).toBe(String(year - 1));
    expect(queries.at(-1)?.get("uncategorized")).toBe("true");
    await click("Clear filters");
    expect(queries.at(-1)?.size).toBe(0);
    expect(selectedAccounts()).toEqual([]);
    expect(button("All time").getAttribute("aria-pressed")).toBe("true");
    expect(button("Uncategorized expenses").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await click("Card", true);
    await click("Card", true);
    expect(selectedAccounts()).toEqual([]);
  });

  it("discards late responses and keeps the latest period selected", async () => {
    const older = Promise.withResolvers<Response>();
    respond((url) => {
      if (url.searchParams.get("year") === String(year - 1))
        return older.promise;
      return Response.json({
        ...data,
        transactions: [transaction("Current expense")],
      });
    });
    await mount();
    await click("Previous year");
    expect(rowNames()).toEqual([]);
    expect(container.textContent).toContain("Loading finances");
    await click("Current year");
    expect(rowNames()).toEqual(["Current expense"]);
    await act(async () =>
      older.resolve(
        Response.json({
          ...data,
          transactions: [transaction("Older expense")],
        }),
      ),
    );
    expect(rowNames()).toEqual(["Current expense"]);
    expect(button("Current year").getAttribute("aria-pressed")).toBe("true");
  });

  it("loads another page with the active filters and resets pagination when filters change", async () => {
    const cursor = JSON.stringify({ date: `${year}-01-01`, id: "Coffee" });
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json({
        ...data,
        nextCursor: url.searchParams.has("cursor") ? null : cursor,
        transactions: [
          transaction(
            url.searchParams.has("cursor") ? "Older expense" : "Coffee",
          ),
        ],
      });
    });
    await mount();
    await click("Savings");
    await click("Current year");
    await click("Uncategorized expenses");
    await click("Load more transactions");
    expect(queries.at(-1)?.get("cursor")).toBe(cursor);
    expect(queries.at(-1)?.get("accountId")).toBe("savings");
    expect(queries.at(-1)?.get("year")).toBe(String(year));
    expect(queries.at(-1)?.get("uncategorized")).toBe("true");
    expect(rowNames()).toEqual(["Coffee", "Older expense"]);
    await click("Previous year");
    expect(queries.at(-1)?.has("cursor")).toBe(false);
    expect(rowNames()).toEqual(["Coffee"]);
  });

  it("shows retry on a filter failure and a useful empty state on success", async () => {
    let failed = true;
    respond((url) =>
      url.searchParams.has("year") && failed
        ? Response.json(
            { error: "Could not fetch this period." },
            { status: 503 },
          )
        : Response.json({
            ...data,
            transactions: url.searchParams.has("year") ? [] : data.transactions,
          }),
    );
    await mount();
    await click("Previous year");
    expect(container.textContent).toContain("Could not fetch this period.");
    expect(rowNames()).toEqual([]);
    failed = false;
    await click("Retry");
    expect(container.textContent).toContain(
      "No transactions match these filters",
    );
    expect(container.textContent).not.toContain("No transactions imported yet");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
  });

  it("removes newly categorized expenses immediately and restores them if saving fails", async () => {
    const save = Promise.withResolvers<Response>();
    respond((_url, init) =>
      init?.method === "PUT" ? save.promise : Response.json(data),
    );
    await mount();
    await click("Uncategorized expenses");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Expense category for Coffee"]',
    );
    if (!select) throw new Error("Missing category picker");
    await act(async () => {
      select.value = "meals";
      select.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
    expect(rowNames()).toEqual(["Supplies"]);
    await act(async () =>
      save.resolve(
        Response.json({ error: "Could not save category." }, { status: 500 }),
      ),
    );
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
    expect(container.textContent).toContain("Could not save category.");
  });
});
