import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type {
  FinanceData,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Finance } from "./Finance";

const dom = new Window({ url: "http://localhost:5173/finance" });
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;
let currentPath = "";
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
  categories: [
    { id: "meals", name: "Meals", slug: "meals", transactionCount: 0 },
  ],
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
    Element: dom.Element,
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
/** Renders Finance at a path; the result navigates as Back or a link would. */
async function mount(pathname = "/finance") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (path: string) => {
    currentPath = path;
    root?.render(<Finance onNavigate={render} pathname={path} />);
  };
  await act(async () => render(pathname));
  return (path: string) => act(async () => render(path));
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
    expect(currentPath).toBe("/finance/expenses/category/uncategorized");
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
    expect(currentPath).toBe("/finance");
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

  it("keeps all loaded rows and the annotation form while refreshing a saved note", async () => {
    const cursor = JSON.stringify({ date: `${year}-01-01`, id: "Coffee" });
    const refreshed = Promise.withResolvers<Response>();
    let saved = false;
    let cursorRequests = 0;
    respond((url, init) => {
      if (init?.method === "PATCH") {
        saved = true;
        return Response.json({
          annotation: { labels: [], note: "", reviewed: true },
        });
      }
      if (url.searchParams.has("cursor")) {
        cursorRequests++;
        return Response.json({
          ...data,
          nextCursor: "older-cursor",
          transactions: [
            transaction("Older expense", {
              annotation: { labels: [], note: "", reviewed: saved },
            }),
          ],
        });
      }
      if (saved) return refreshed.promise;
      return Response.json({
        ...data,
        nextCursor: cursor,
        transactions: [transaction("Coffee")],
      });
    });
    await mount();
    await click("Load more transactions");
    const annotate = container.querySelectorAll<HTMLButtonElement>(
      ".financeTransactionAction",
    )[1];
    await act(async () => annotate?.click());
    const form = container.querySelector<HTMLFormElement>(
      '[aria-label="Annotation for Older expense"]',
    );
    if (!form) throw new Error("No annotation form for the older transaction");
    await act(async () =>
      form.dispatchEvent(
        new dom.Event("submit", {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      ),
    );
    expect(rowNames()).toEqual(["Coffee", "Older expense"]);
    expect(container.contains(form)).toBe(true);
    expect(container.textContent).not.toContain("Loading finances");
    expect(button("Load more transactions").disabled).toBe(true);
    await click("Load more transactions");
    expect(cursorRequests).toBe(1);
    await act(async () =>
      refreshed.resolve(
        Response.json({
          ...data,
          nextCursor: cursor,
          transactions: [transaction("Coffee")],
        }),
      ),
    );
    expect(rowNames()).toEqual(["Coffee", "Older expense"]);
    expect(container.contains(form)).toBe(true);
    expect(cursorRequests).toBe(2);
    expect(button("Load more transactions").disabled).toBe(false);
    expect(
      container.querySelectorAll(".financeTransactionStatus")[1]?.textContent,
    ).toBe("Reviewed");
  });

  it("keeps earlier pages visible after a load-more failure and retries the same cursor", async () => {
    const cursor = JSON.stringify({ date: `${year}-01-01`, id: "Coffee" });
    const cursors: string[] = [];
    respond((url) => {
      const requestedCursor = url.searchParams.get("cursor");
      if (!requestedCursor)
        return Response.json({
          ...data,
          nextCursor: cursor,
          transactions: [transaction("Coffee")],
        });
      cursors.push(requestedCursor);
      return cursors.length === 1
        ? Response.json(
            { error: "Older transactions are temporarily unavailable." },
            { status: 503 },
          )
        : Response.json({
            ...data,
            transactions: [transaction("Older expense")],
          });
    });
    await mount();
    await click("Load more transactions");
    expect(rowNames()).toEqual(["Coffee"]);
    expect(container.textContent).toContain(
      "Older transactions are temporarily unavailable.",
    );
    await click("Retry loading more");
    expect(cursors).toEqual([cursor, cursor]);
    expect(rowNames()).toEqual(["Coffee", "Older expense"]);
    expect(container.textContent).not.toContain(
      "Older transactions are temporarily unavailable.",
    );
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

  it("drills into one category from Categories, drops recategorized rows, and clears back to all", async () => {
    const queries: URLSearchParams[] = [];
    const categories = [
      { id: "category-1", name: "Meals", slug: "meals", transactionCount: 2 },
      { id: "category-2", name: "Travel", slug: "travel", transactionCount: 0 },
    ];
    respond((url, init) => {
      if (init?.method === "PUT")
        return Response.json({ expenseCategoryId: "category-2" });
      queries.push(url.searchParams);
      const slug = url.searchParams.get("category");
      const expenseCategoryId =
        categories.find((category) => category.slug === slug)?.id ?? null;
      return Response.json({
        ...data,
        categories,
        transactions: slug
          ? [
              transaction("Lunch", { expenseCategoryId }),
              transaction("Dinner", { expenseCategoryId }),
            ]
          : data.transactions,
      });
    });
    await mount("/finance/categories");
    await click("Meals");
    expect(currentPath).toBe("/finance/expenses/category/meals");
    expect(queries.at(-1)?.get("category")).toBe("meals");
    expect(rowNames()).toEqual(["Lunch", "Dinner"]);
    expect(button("Category: Meals").getAttribute("aria-pressed")).toBe("true");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Expense category for Lunch"]',
    );
    if (!select) throw new Error("Missing category picker");
    await act(async () => {
      select.value = "category-2";
      select.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
    expect(rowNames()).toEqual(["Dinner"]);
    await click("Category: Meals");
    expect(currentPath).toBe("/finance");
    expect(queries.at(-1)?.has("category")).toBe(false);
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
  });

  it("opens a category from its row's context menu, including an empty one", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json({
        ...data,
        categories: [
          {
            id: "travel",
            name: "Travel",
            slug: "travel",
            transactionCount: 0,
          },
        ],
        transactions: url.searchParams.has("category") ? [] : data.transactions,
      });
    });
    await mount("/finance/categories");
    const row = button("Travel").closest("li");
    if (!row) throw new Error("Missing category row");
    await act(async () => {
      row.dispatchEvent(
        new dom.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }) as unknown as MouseEvent,
      );
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Actions for Travel");
    const show = [
      ...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ].find((item) => item.textContent === "Show transactions");
    if (!show) throw new Error("Missing Show transactions");
    await act(async () => show.click());
    expect(queries.at(-1)?.get("category")).toBe("travel");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(button("Category: Travel").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.textContent).toContain(
      "No transactions match these filters",
    );
  });

  it("opens a bookmarked category path with one filtered request", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json(data);
    });
    await mount("/finance/expenses/category/meals");
    expect(queries.map((query) => query.get("category"))).toEqual(["meals"]);
    expect(button("Category: Meals").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Overview",
    );
  });

  it("opens and leaves the bookmarked uncategorized path", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json(data);
    });
    await mount("/finance/expenses/category/uncategorized");
    expect(queries).toHaveLength(1);
    expect(queries[0]?.get("uncategorized")).toBe("true");
    expect(queries[0]?.has("category")).toBe(false);
    expect(button("Uncategorized expenses").getAttribute("aria-pressed")).toBe(
      "true",
    );
    await click("Uncategorized expenses");
    expect(currentPath).toBe("/finance");
    expect(queries.at(-1)?.has("uncategorized")).toBe(false);
  });

  it("follows Back to a category path and keeps the other filters", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json(data);
    });
    const navigate = await mount();
    await click("Previous year");
    await navigate("/finance/expenses/category/meals");
    expect(queries.at(-1)?.get("category")).toBe("meals");
    expect(queries.at(-1)?.get("year")).toBe(String(year - 1));
    const count = queries.length;
    await navigate("/finance/categories");
    expect(queries).toHaveLength(count);
    await navigate("/finance");
    expect(queries.at(-1)?.has("category")).toBe(false);
    expect(queries.at(-1)?.get("year")).toBe(String(year - 1));
  });

  it("explains a category path that matches no category", async () => {
    respond(() => Response.json({ ...data, transactions: [] }));
    await mount("/finance/expenses/category/dining");
    expect(button("Category: dining").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.textContent).toContain("Category not found");
    await click("View categories");
    expect(currentPath).toBe("/finance/categories");
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
