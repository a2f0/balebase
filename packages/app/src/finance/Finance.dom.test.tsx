import { afterEach, describe, expect, it } from "bun:test";
import type {
  FinanceData,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { act } from "react";
import { holdTimers, installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { transactionIssuePath } from "../workspace/workspacePaths";
import { Finance } from "./Finance";
import { syncPollMs } from "./financeConnectionActions";

const {
  mount,
  respond: respondFetch,
  window: dom,
} = installDom({
  url: "http://localhost:5173/finance",
  globals: () => ({
    IntersectionObserver: IntersectionObserverFixture,
  }),
});
let container: HTMLElement;
let currentPath = "";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/**
 * Answers Finance's requests from `handler`, which answers the plain
 * listing (`GET /api/finance`) with everything, as tests did before devices
 * kept transactions: the summary request gets that listing, and the change
 * feed is worked out from it against what the device was last sent.
 */
function respond(handler: Handler) {
  const sent: Map<string, FinanceTransaction>[] = [];
  respondFetch(async (url, init) => {
    if (!url.pathname.endsWith("/api/finance/transactions/changes"))
      return handler(url, init);
    const response = await handler(new URL("/api/finance", url), init);
    if (!response.ok) return response;
    const listing = (await response.json()) as FinanceData;
    const current = new Map(listing.transactions.map((row) => [row.id, row]));
    const cursor = url.searchParams.get("cursor");
    const previous =
      cursor === null ? new Map() : (sent[Number(cursor)] ?? new Map());
    sent.push(current);
    return Response.json({
      cursor: String(sent.length - 1),
      more: false,
      organizationId: "organization",
      removedIds: [...previous.keys()].filter((id) => !current.has(id)),
      reset: false,
      transactions: [...current.values()],
    });
  });
}

/**
 * Whether a request reached `handler` for the change feed (each load reads
 * it once) rather than for the summary.
 */
function isFeed(url: URL) {
  return (
    url.pathname.endsWith("/api/finance") &&
    !url.searchParams.has("transactions")
  );
}
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
    transaction("Coffee", { transactionDate: `${year}-01-02` }),
    transaction("Supplies", { accountId: "savings" }),
  ],
};

afterEach(() => {
  IntersectionObserverFixture.instances.length = 0;
});

/** Renders Finance at a path; the result navigates as Back or a link would. */
async function mountFinance(pathname = "/finance") {
  const page = (path: string) => {
    currentPath = path;
    return <Finance onNavigate={navigate} pathname={path} />;
  };
  const view = await mount(page(pathname));
  container = view.container;
  function navigate(path: string) {
    view.root.render(page(path));
  }
  return (path: string) => act(async () => navigate(path));
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
/** Opens a transaction row's menu from its menu button. */
async function openRowMenu(name: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[aria-label="Actions for ${name}"]`,
  );
  if (!trigger) throw new Error(`No menu for ${name}`);
  await act(async () => trigger.click());
}
function menuItems() {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent,
  );
}
async function choose(label: string) {
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await act(async () => item.click());
}
function selectedAccounts() {
  return [
    ...container.querySelectorAll(
      '.financeAccount[aria-pressed="true"] .financeAccountName',
    ),
  ].map((node) => node.textContent);
}

describe("Finance filters", () => {
  /** Transactions dated newest first in the order given. */
  function dated(names: string[], overrides: Partial<FinanceTransaction> = {}) {
    return names.map((name, index) =>
      transaction(name, {
        ...overrides,
        transactionDate: new Date(Date.UTC(year, 0, 1) - index * 86400000)
          .toISOString()
          .slice(0, 10),
      }),
    );
  }

  it("filters saved transactions on the device without asking the server again", async () => {
    let requests = 0;
    respond(() => {
      requests++;
      return Response.json({
        ...data,
        transactions: [
          transaction("Fuel", {
            accountId: "checking",
            transactionDate: `${year}-03-01`,
          }),
          transaction("Rent", {
            accountId: "savings",
            transactionDate: `${year}-02-01`,
          }),
          transaction("Paid", {
            accountId: "savings",
            expenseCategoryId: "meals",
            transactionDate: `${year}-01-15`,
          }),
          transaction("Transfer", {
            accountId: "savings",
            categoryPrimary: "TRANSFER_OUT",
            transactionDate: `${year}-01-10`,
          }),
          transaction("Refund", {
            accountId: "savings",
            amount: -5,
            transactionDate: `${year}-01-05`,
          }),
          transaction("Old", {
            accountId: "card",
            transactionDate: `${year - 1}-06-01`,
          }),
        ],
      });
    });
    await mountFinance();
    // One load reads the summary and the change feed.
    expect(requests).toBe(2);
    expect(rowNames()).toEqual([
      "Fuel",
      "Rent",
      "Paid",
      "Transfer",
      "Refund",
      "Old",
    ]);
    await click("Checking");
    expect(selectedAccounts()).toEqual(["Checking"]);
    expect(rowNames()).toEqual(["Fuel"]);
    await click("Savings", true);
    expect(selectedAccounts()).toEqual(["Checking", "Savings"]);
    await click("Current year");
    await click("Uncategorized expenses");
    expect(currentPath).toBe("/finance/expenses/category/uncategorized");
    // Uncategorized expenses leave out categorized rows, transfers, and refunds.
    expect(rowNames()).toEqual(["Fuel", "Rent"]);
    await click("Checking", true);
    expect(rowNames()).toEqual(["Rent"]);
    await click("Previous year");
    expect(button("Current year").getAttribute("aria-pressed")).toBe("false");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual([]);
    await click("All accounts");
    expect(selectedAccounts()).toEqual([]);
    expect(rowNames()).toEqual(["Old"]);
    await click("Clear filters");
    expect(currentPath).toBe("/finance");
    expect(rowNames()).toHaveLength(6);
    expect(button("All time").getAttribute("aria-pressed")).toBe("true");
    expect(button("Uncategorized expenses").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await click("Card", true);
    await click("Card", true);
    expect(selectedAccounts()).toEqual([]);
    expect(requests).toBe(2);
  });

  it("shows saved transactions a page at a time and starts over when filters change", async () => {
    const rows = dated(
      Array.from({ length: 300 }, (_, index) => `Row ${index}`),
    );
    let requests = 0;
    respond(() => {
      requests++;
      return Response.json({ ...data, transactions: rows });
    });
    await mountFinance();
    expect(rowNames()).toHaveLength(250);
    expect(container.textContent).toContain("250 of 300 shown");
    await act(async () => IntersectionObserverFixture.intersect());
    expect(rowNames()).toHaveLength(300);
    expect(container.textContent).toContain("300 shown");
    expect(container.textContent).not.toContain("Load more transactions");
    await click("Previous year");
    expect(rowNames()).toHaveLength(250);
    expect(container.textContent).toContain("250 of 299 shown");
    await click("All time");
    expect(rowNames()).toHaveLength(250);
    expect(requests).toBe(2);
  });

  it("annotates, raises an issue, or filters by name from a row's menu", async () => {
    respond(() =>
      Response.json({
        ...data,
        transactions: [
          ...dated(["shell-1", "Olive Garden", "shell-2"]).map((row) =>
            row.id.startsWith("shell")
              ? { ...row, merchantName: "Shell", name: row.id.toUpperCase() }
              : row,
          ),
          transaction("shell-old", {
            merchantName: "Shell",
            transactionDate: `${year - 1}-05-01`,
          }),
        ],
      }),
    );
    await mountFinance();
    // The row's actions are in its menu, not buttons of their own.
    expect(container.textContent).not.toContain("Raise issue");
    expect(container.textContent).not.toContain("Annotate");
    const row = container.querySelector(".financeTransaction");
    if (!row) throw new Error("No transaction row");
    await act(async () =>
      row.dispatchEvent(
        new dom.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }) as unknown as Event,
      ),
    );
    expect(menuItems()).toEqual([
      "Annotate",
      "Raise issue",
      "Show only “Shell”",
    ]);
    await act(async () =>
      document.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }) as unknown as Event,
      ),
    );
    await openRowMenu("Olive Garden");
    await choose("Annotate");
    expect(
      container.querySelector('[aria-label="Annotation for Olive Garden"]'),
    ).not.toBeNull();
    await openRowMenu("Shell");
    await choose("Show only “Shell”");
    expect(rowNames()).toEqual(["Shell", "Shell", "Shell"]);
    expect(button("Name: Shell").getAttribute("aria-pressed")).toBe("true");
    await click("Previous year");
    expect(rowNames()).toEqual(["Shell", "Shell"]);
    await click("Name: Shell");
    expect(rowNames()).toEqual(["Olive Garden", "Shell", "Shell"]);
    await click("All time");
    expect(rowNames()).toEqual(["Shell", "Olive Garden", "Shell", "Shell"]);
    await openRowMenu("Olive Garden");
    await choose("Raise issue");
    expect(currentPath).toBe(transactionIssuePath("Olive Garden"));
  });

  it("keeps every shown row and the annotation form while a saved note refreshes", async () => {
    const rows = dated(
      Array.from({ length: 260 }, (_, index) => `Row ${index}`),
    );
    const refreshed = Promise.withResolvers<void>();
    let saved = false;
    respond(async (url, init) => {
      if (init?.method === "PATCH") {
        saved = true;
        return Response.json({
          annotation: { labels: [], note: "", reviewed: true },
        });
      }
      if (saved && isFeed(url)) await refreshed.promise;
      return Response.json({
        ...data,
        transactions: rows.map((row) =>
          row.id === "Row 255"
            ? { ...row, annotation: { labels: [], note: "", reviewed: saved } }
            : row,
        ),
      });
    });
    await mountFinance();
    await click("Load more transactions");
    await openRowMenu("Row 255");
    await choose("Annotate");
    const form = container.querySelector<HTMLFormElement>(
      '[aria-label="Annotation for Row 255"]',
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
    expect(rowNames()).toHaveLength(260);
    expect(container.contains(form)).toBe(true);
    expect(container.textContent).not.toContain("Loading finances");
    await act(async () => refreshed.resolve());
    expect(rowNames()).toHaveLength(260);
    expect(container.contains(form)).toBe(true);
    expect(
      container.querySelectorAll(".financeTransactionStatus")[255]?.textContent,
    ).toBe("Reviewed");
  });

  it("shows the saved copy when the server cannot be reached, and recovers", async () => {
    let down = false;
    respond(() =>
      down
        ? Response.json({ error: "Service unavailable." }, { status: 503 })
        : Response.json(data),
    );
    const navigate = await mountFinance();
    down = true;
    // Leaving and returning to the overview reloads it.
    await navigate("/finance/categories");
    await navigate("/finance");
    expect(container.textContent).toContain(
      "Showing transactions saved on this device",
    );
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
    down = false;
    await click("Retry");
    expect(container.textContent).not.toContain(
      "Showing transactions saved on this device",
    );
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
  });

  it("keeps nothing for someone who loses access", async () => {
    let refused = false;
    respond(() =>
      refused
        ? Response.json({ error: "Finance access required." }, { status: 403 })
        : Response.json(data),
    );
    const navigate = await mountFinance();
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
    refused = true;
    await navigate("/finance/categories");
    await navigate("/finance");
    expect(container.textContent).toContain("Finance access required.");
    expect(rowNames()).toEqual([]);
    expect(container.textContent).not.toContain(
      "Showing transactions saved on this device",
    );
    refused = false;
    // What was kept is gone: the next load starts from the beginning.
    let fromStart = false;
    respondFetch((url) => {
      if (url.pathname.endsWith("/transactions/changes"))
        fromStart = !url.searchParams.has("cursor");
      return url.pathname.endsWith("/transactions/changes")
        ? Response.json({
            cursor: "0",
            more: false,
            organizationId: "organization",
            removedIds: [],
            reset: false,
            transactions: data.transactions,
          })
        : Response.json(data);
    });
    await click("Retry");
    expect(fromStart).toBe(true);
  });

  it("shows retry when the first load fails and a useful empty state on success", async () => {
    let failed = true;
    respond(() =>
      failed
        ? Response.json({ error: "Could not load finances." }, { status: 503 })
        : Response.json(data),
    );
    await mountFinance();
    expect(container.textContent).toContain("Could not load finances.");
    expect(rowNames()).toEqual([]);
    failed = false;
    await click("Retry");
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
    await click("Previous year");
    expect(container.textContent).toContain(
      "No transactions match these filters",
    );
    expect(container.textContent).not.toContain("No transactions imported yet");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
  });

  it("drills into one category from Categories, drops recategorized rows, and clears back to all", async () => {
    const categories = [
      { id: "category-1", name: "Meals", slug: "meals", transactionCount: 2 },
      { id: "category-2", name: "Travel", slug: "travel", transactionCount: 0 },
    ];
    respond((_url, init) => {
      if (init?.method === "PUT")
        return Response.json({ expenseCategoryId: "category-2" });
      return Response.json({
        ...data,
        categories,
        transactions: [
          ...data.transactions,
          ...dated(["Lunch", "Dinner"], { expenseCategoryId: "category-1" }),
        ],
      });
    });
    await mountFinance("/finance/categories");
    await click("Meals");
    expect(currentPath).toBe("/finance/expenses/category/meals");
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
    // Supplies and Lunch share a date; the later ID comes first.
    expect(rowNames()).toEqual(["Coffee", "Supplies", "Lunch", "Dinner"]);
  });

  it("opens a category from its row's context menu, including an empty one", async () => {
    respond(() =>
      Response.json({
        ...data,
        categories: [
          {
            id: "travel",
            name: "Travel",
            slug: "travel",
            transactionCount: 0,
          },
        ],
      }),
    );
    await mountFinance("/finance/categories");
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
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(button("Category: Travel").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.textContent).toContain(
      "No transactions match these filters",
    );
  });

  it("opens a bookmarked category path with one load", async () => {
    let requests = 0;
    respond(() => {
      requests++;
      return Response.json({
        ...data,
        transactions: [
          ...data.transactions,
          transaction("Lunch", { expenseCategoryId: "meals" }),
        ],
      });
    });
    await mountFinance("/finance/expenses/category/meals");
    expect(requests).toBe(2);
    expect(rowNames()).toEqual(["Lunch"]);
    expect(button("Category: Meals").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Overview",
    );
  });

  it("opens and leaves the bookmarked uncategorized path", async () => {
    respond(() =>
      Response.json({
        ...data,
        transactions: [
          ...data.transactions,
          transaction("Lunch", { expenseCategoryId: "meals" }),
        ],
      }),
    );
    await mountFinance("/finance/expenses/category/uncategorized");
    expect(button("Uncategorized expenses").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(rowNames()).toEqual(["Coffee", "Supplies"]);
    await click("Uncategorized expenses");
    expect(currentPath).toBe("/finance");
    expect(rowNames()).toEqual(["Coffee", "Supplies", "Lunch"]);
  });

  it("follows Back to a category path and keeps the other filters", async () => {
    respond(() =>
      Response.json({
        ...data,
        transactions: [
          ...data.transactions,
          transaction("Lunch", {
            expenseCategoryId: "meals",
            transactionDate: `${year - 1}-03-01`,
          }),
          transaction("Brunch", { expenseCategoryId: "meals" }),
        ],
      }),
    );
    const navigate = await mountFinance();
    await click("Previous year");
    await navigate("/finance/expenses/category/meals");
    expect(button("Category: Meals").getAttribute("aria-pressed")).toBe("true");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Lunch"]);
    await navigate("/finance/categories");
    await navigate("/finance");
    expect(button("Previous year").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Lunch"]);
  });

  it("explains a category path that matches no category", async () => {
    respond(() => Response.json({ ...data, transactions: [] }));
    await mountFinance("/finance/expenses/category/dining");
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
    await mountFinance();
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

describe("Bulk categorization", () => {
  // Newest first in this order, as the list shows them.
  const rows = ["Coffee", "Lunch", "Supplies", "Taxi"].map((id, index) =>
    transaction(id, { transactionDate: `${year}-01-0${4 - index}` }),
  );
  /** Many rows, dated so the list shows them in order. */
  const manyRows = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      transaction(`Row ${index}`, {
        transactionDate: new Date(Date.UTC(year, 0, 1) - index * 86400000)
          .toISOString()
          .slice(0, 10),
      }),
    );
  const listing: FinanceData = {
    ...data,
    categories: [
      { id: "meals", name: "Meals", slug: "meals", transactionCount: 0 },
      { id: "travel", name: "Travel", slug: "travel", transactionCount: 0 },
    ],
    transactions: rows,
  };
  function checkbox(label: string) {
    const input = container.querySelector<HTMLInputElement>(
      `input[type="checkbox"][aria-label="${label}"]`,
    );
    if (!input) throw new Error(`Missing checkbox: ${label}`);
    return input;
  }
  async function check(label: string, shiftKey = false) {
    await act(async () => {
      checkbox(label).dispatchEvent(
        new dom.MouseEvent("click", {
          bubbles: true,
          shiftKey,
        }) as unknown as MouseEvent,
      );
    });
  }
  /** Checked rows among those shown. */
  function checkedRows() {
    return rows
      .map(({ id }) => id)
      .filter(
        (id) =>
          container.querySelector<HTMLInputElement>(
            `input[type="checkbox"][aria-label="Select ${id}"]`,
          )?.checked,
      );
  }
  async function setBulkCategory(value: string) {
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Category for selected transactions"]',
    );
    if (!select) throw new Error("Missing bulk category picker");
    await act(async () => {
      select.value = value;
      select.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
  }
  function categoryOf(name: string) {
    return container.querySelector<HTMLSelectElement>(
      `[aria-label="Expense category for ${name}"]`,
    )?.value;
  }

  /**
   * A server that keeps the categories it saves, so the refresh after a bulk
   * save lists them; `hold` delays each save, and `fail` refuses the saves
   * it picks by their order (0 for the first).
   */
  function serveCategories(options: {
    fail?: (attempt: number) => boolean;
    hold?: Promise<void>;
    transactions?: FinanceTransaction[];
  }) {
    const listed = options.transactions ?? rows;
    const stored = new Map<string, string | null>();
    const saves: { categoryId: string | null; transactionIds: string[] }[] = [];
    let attempts = 0;
    const server = { loads: 0, saves };
    respond(async (url, init) => {
      if (init?.method !== "PUT") {
        if (isFeed(url)) server.loads++;
        return Response.json({
          ...listing,
          transactions: listed.map((row) => ({
            ...row,
            expenseCategoryId: stored.get(row.id) ?? null,
          })),
        });
      }
      await options.hold;
      if (options.fail?.(attempts++)) {
        return Response.json({ error: "Could not save." }, { status: 500 });
      }
      const body = JSON.parse(String(init.body));
      saves.push(body);
      for (const id of body.transactionIds) stored.set(id, body.categoryId);
      return Response.json(body);
    });
    return server;
  }

  it("selects all, a range with Shift, or none, then categorizes the selection in one save", async () => {
    const { saves } = serveCategories({});
    await mountFinance();
    const all = () => checkbox("Select all shown transactions");
    expect(container.textContent).toContain(
      "Select transactions to categorize them together",
    );

    await check("Select Lunch");
    await check("Select Taxi", true);
    expect(checkedRows()).toEqual(["Lunch", "Supplies", "Taxi"]);
    expect(container.textContent).toContain("3 selected");
    const partial = checkbox("Clear selection");
    expect(partial.indeterminate).toBe(true);
    expect(partial.checked).toBe(false);
    // A partial selection clears first, as in Gmail; the next click selects all.
    await check("Clear selection");
    expect(checkedRows()).toEqual([]);
    await act(async () => {
      all().dispatchEvent(
        new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent,
      );
    });
    expect(checkedRows()).toEqual(["Coffee", "Lunch", "Supplies", "Taxi"]);
    expect(checkbox("Clear selection").checked).toBe(true);
    await check("Select Coffee");

    await setBulkCategory("travel");
    expect(saves).toEqual([
      { categoryId: "travel", transactionIds: ["Lunch", "Supplies", "Taxi"] },
    ]);
    expect(rows.map(({ id }) => categoryOf(id))).toEqual([
      "",
      "travel",
      "travel",
      "travel",
    ]);
    expect(checkedRows()).toEqual([]);
    expect(container.textContent).not.toContain("3 selected");

    // Rows already in the category are not sent again; others move from theirs.
    await check("Select Coffee");
    await check("Select Lunch");
    await setBulkCategory("uncategorized");
    expect(saves.at(-1)).toEqual({
      categoryId: null,
      transactionIds: ["Lunch"],
    });
    expect(categoryOf("Lunch")).toBe("");
  });

  it("restores the rows and keeps the selection when saving fails", async () => {
    respond((_url, init) =>
      init?.method === "PUT"
        ? Response.json(
            { error: "Could not save categories." },
            { status: 500 },
          )
        : Response.json(listing),
    );
    await mountFinance();
    await check("Select Coffee");
    await check("Select Supplies");
    await setBulkCategory("meals");
    expect(container.textContent).toContain("Could not save categories.");
    expect(rows.map(({ id }) => categoryOf(id))).toEqual(["", "", "", ""]);
    expect(checkedRows()).toEqual(["Coffee", "Supplies"]);
  });

  it("starts a new selection whichever control changes the filters", async () => {
    respond(() => Response.json(listing));
    await mountFinance();
    await check("Select Coffee");
    await click("Uncategorized expenses");
    expect(checkedRows()).toEqual([]);
    expect(container.textContent).not.toContain("1 selected");
    // An account card changes the filters outside the filter toolbar.
    await check("Select Lunch");
    await click("Checking");
    expect(checkedRows()).toEqual([]);
    await check("Select Taxi");
    await click("All accounts");
    expect(checkedRows()).toEqual([]);
    // Returning to the earlier filters does not bring their selection back.
    await check("Select Coffee");
    await click("Checking");
    await click("All accounts");
    expect(checkedRows()).toEqual([]);
  });

  for (const outcome of ["saved", "failed"] as const) {
    it(`settles on the server's rows when a load lands during a bulk save that ${outcome}`, async () => {
      const save = Promise.withResolvers<void>();
      const server = serveCategories({
        fail: () => outcome === "failed",
        hold: save.promise,
      });
      const navigate = await mountFinance();
      await check("Select Coffee");
      await setBulkCategory("meals");
      expect(categoryOf("Coffee")).toBe("meals");
      // A load mid-save (here, leaving and coming back) reads the rows as the
      // server has them now.
      await navigate("/finance/categories");
      await navigate("/finance");
      expect(categoryOf("Coffee")).toBe("");
      const before = server.loads;
      await act(async () => save.resolve());
      expect(server.loads).toBe(before + 1);
      expect(categoryOf("Coffee")).toBe(outcome === "saved" ? "meals" : "");
    });
  }

  it("keeps the batches that saved when a later one fails, and retries only the rest", async () => {
    const server = serveCategories({
      fail: (attempt) => attempt === 1,
      transactions: manyRows(252),
    });
    await mountFinance();
    await click("Load more transactions");
    await check("Select all shown transactions");
    await setBulkCategory("meals");
    expect(container.textContent).toContain("Could not save.");
    expect(
      server.saves.map(({ transactionIds }) => transactionIds.length),
    ).toEqual([250]);
    // The first batch stays categorized; the refused rows go back.
    expect(categoryOf("Row 0")).toBe("meals");
    expect(categoryOf("Row 249")).toBe("meals");
    expect(categoryOf("Row 250")).toBe("");
    expect(categoryOf("Row 251")).toBe("");
    expect(container.textContent).toContain("252 selected");

    await setBulkCategory("meals");
    // The retry sends one request, for the refused rows only.
    expect(server.saves.slice(1)).toEqual([
      { categoryId: "meals", transactionIds: ["Row 250", "Row 251"] },
    ]);
    expect(categoryOf("Row 251")).toBe("meals");
    expect(container.textContent).not.toContain("252 selected");
  });

  it("holds bulk changes until a row's own category save finishes", async () => {
    const save = Promise.withResolvers<Response>();
    respond((_url, init) =>
      init?.method === "PUT" ? save.promise : Response.json(listing),
    );
    await mountFinance();
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
    expect(checkbox("Select all shown transactions").disabled).toBe(true);
    expect(checkbox("Select Lunch").disabled).toBe(true);
    await act(async () =>
      save.resolve(Response.json({ expenseCategoryId: "meals" })),
    );
    expect(checkbox("Select all shown transactions").disabled).toBe(false);
    expect(categoryOf("Coffee")).toBe("meals");
  });

  it("holds every row's category picker until a bulk save finishes", async () => {
    const save = Promise.withResolvers<void>();
    serveCategories({ hold: save.promise });
    await mountFinance();
    await check("Select Coffee");
    await setBulkCategory("meals");
    const picker = (name: string) =>
      container.querySelector<HTMLSelectElement>(
        `[aria-label="Expense category for ${name}"]`,
      );
    expect(picker("Lunch")?.disabled).toBe(true);
    expect(checkbox("Select Lunch").disabled).toBe(true);
    await act(async () => save.resolve());
    expect(picker("Lunch")?.disabled).toBe(false);
    expect(categoryOf("Coffee")).toBe("meals");
  });

  it("saves more than one request's worth of rows in batches", async () => {
    const many = manyRows(251);
    const saves: string[][] = [];
    respond(async (_url, init) => {
      if (init?.method !== "PUT") {
        return Response.json({ ...listing, transactions: many });
      }
      const body = JSON.parse(String(init.body));
      saves.push(body.transactionIds);
      return Response.json(body);
    });
    await mountFinance();
    // Select all takes the rows shown: show the rest first.
    await check("Select all shown transactions");
    expect(container.textContent).toContain("250 selected");
    await check("Clear selection");
    await click("Load more transactions");
    await check("Select all shown transactions");
    expect(container.textContent).toContain("251 selected");
    await setBulkCategory("meals");
    expect(saves.map((ids) => ids.length)).toEqual([250, 1]);
    expect(saves.flat()).toEqual(many.map(({ id }) => id));
  });
});

it("polls a running bank sync and catches up once it finishes", async () => {
  using polls = holdTimers(syncPollMs);
  let feedRequests = 0;
  let statusRequests = 0;
  let finished = false;
  const listing: FinanceData = {
    ...data,
    connections: [
      {
        id: "connection-1",
        institutionId: null,
        institutionName: "Bank",
        accountCount: 1,
        createdAt: "2026-01-01",
        errorCode: null,
        lastSyncedAt: null,
        status: "active",
        dailySync: true,
        syncStatus: "running",
      },
    ],
  };
  respond((url) => {
    if (url.pathname.endsWith("/sync-status")) {
      statusRequests++;
      return Response.json({
        connection: {
          syncJob: { status: finished ? "succeeded" : "running" },
        },
      });
    }
    if (isFeed(url)) feedRequests++;
    return Response.json(
      finished
        ? {
            ...listing,
            connections: [],
            transactions: [...data.transactions, transaction("New expense")],
          }
        : listing,
    );
  });
  await mountFinance();
  expect(feedRequests).toBe(1);
  await polls.fire();
  expect(statusRequests).toBe(1);
  expect(feedRequests).toBe(1);
  expect(rowNames()).toEqual(["Coffee", "Supplies"]);
  finished = true;
  await polls.fire();
  expect(feedRequests).toBe(2);
  expect(rowNames()).toEqual(["Coffee", "Supplies", "New expense"]);
});
