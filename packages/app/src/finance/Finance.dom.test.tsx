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
  respond,
  window: dom,
} = installDom({
  url: "http://localhost:5173/finance",
  globals: () => ({
    IntersectionObserver: IntersectionObserverFixture,
  }),
});
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
  it("ignores an older page and stale observer when account filters change during infinite loading", async () => {
    const older = Promise.withResolvers<Response>();
    let pageRequests = 0;
    respond((url) => {
      if (url.searchParams.has("cursor")) {
        pageRequests++;
        return older.promise;
      }
      return Response.json({
        ...data,
        transactions: [
          transaction(
            url.searchParams.has("accountId") ? "Filtered" : "Coffee",
          ),
        ],
        nextCursor: url.searchParams.has("accountId") ? null : "older",
      });
    });
    await mountFinance();
    const oldObserver = IntersectionObserverFixture.instances.at(-1);
    await act(async () => {
      IntersectionObserverFixture.intersect();
      IntersectionObserverFixture.intersect();
    });
    expect(pageRequests).toBe(1);
    await click("Savings");
    await act(async () =>
      older.resolve(
        Response.json({
          ...data,
          transactions: [transaction("Stale")],
          nextCursor: "stale-cursor",
        }),
      ),
    );
    await act(async () => oldObserver?.notify());
    expect(pageRequests).toBe(1);
    expect(rowNames()).toEqual(["Filtered"]);
  });
  it("combines Shift account toggles, year shortcuts, and uncategorized expenses, then clears them", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      return Response.json(data);
    });
    await mountFinance();
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
    await mountFinance();
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
        transactions: url.searchParams.has("cursor")
          ? [transaction("Coffee"), transaction("Older expense")]
          : [transaction("Coffee")],
      });
    });
    await mountFinance();
    await click("Savings");
    await click("Current year");
    await click("Uncategorized expenses");
    await act(async () => IntersectionObserverFixture.intersect());
    expect(queries.at(-1)?.get("cursor")).toBe(cursor);
    expect(queries.at(-1)?.get("accountId")).toBe("savings");
    expect(queries.at(-1)?.get("year")).toBe(String(year));
    expect(queries.at(-1)?.get("uncategorized")).toBe("true");
    expect(rowNames()).toEqual(["Coffee", "Older expense"]);
    await click("Previous year");
    expect(queries.at(-1)?.has("cursor")).toBe(false);
    expect(rowNames()).toEqual(["Coffee"]);
  });

  it("annotates, raises an issue, or filters by name from a row's menu", async () => {
    const queries: URLSearchParams[] = [];
    respond((url) => {
      queries.push(url.searchParams);
      const name = url.searchParams.get("name");
      return Response.json({
        ...data,
        transactions: [
          transaction("shell-1", { merchantName: "Shell", name: "SHELL 1" }),
          transaction("Olive Garden"),
          transaction("shell-2", { merchantName: "Shell", name: "SHELL 2" }),
        ].filter((row) => !name || (row.merchantName ?? row.name) === name),
      });
    });
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
    expect(queries.at(-1)?.get("name")).toBe("Shell");
    expect(rowNames()).toEqual(["Shell", "Shell"]);
    expect(button("Name: Shell").getAttribute("aria-pressed")).toBe("true");
    await click("Previous year");
    expect(queries.at(-1)?.get("name")).toBe("Shell");
    expect(queries.at(-1)?.get("year")).toBe(String(year - 1));
    await click("Name: Shell");
    expect(queries.at(-1)?.has("name")).toBe(false);
    expect(rowNames()).toEqual(["Shell", "Olive Garden", "Shell"]);
    await openRowMenu("Olive Garden");
    await choose("Raise issue");
    expect(currentPath).toBe(transactionIssuePath("Olive Garden"));
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
    await mountFinance();
    await click("Load more transactions");
    await openRowMenu("Older expense");
    await choose("Annotate");
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
    await mountFinance();
    await act(async () => IntersectionObserverFixture.intersect());
    expect(rowNames()).toEqual(["Coffee"]);
    expect(container.textContent).toContain(
      "Older transactions are temporarily unavailable.",
    );
    await act(async () => IntersectionObserverFixture.intersect());
    expect(cursors).toEqual([cursor]);
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
    await mountFinance();
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
    await mountFinance("/finance/categories");
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
    await mountFinance("/finance/expenses/category/meals");
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
    await mountFinance("/finance/expenses/category/uncategorized");
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
    const navigate = await mountFinance();
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
  const rows = ["Coffee", "Lunch", "Supplies", "Taxi"].map((id) =>
    transaction(id),
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
  function checkedRows() {
    return rows
      .map(({ id }) => id)
      .filter((id) => checkbox(`Select ${id}`).checked);
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

  it("selects all, a range with Shift, or none, then categorizes the selection in one save", async () => {
    const saves: unknown[] = [];
    respond(async (_url, init) => {
      if (init?.method !== "PUT") return Response.json(listing);
      const body = JSON.parse(String(init.body));
      saves.push(body);
      return Response.json({
        expenseCategoryId: body.categoryId,
        transactionIds: body.transactionIds,
      });
    });
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
    await click("Savings");
    expect(checkedRows()).toEqual([]);
    await check("Select Taxi");
    await click("All accounts");
    expect(checkedRows()).toEqual([]);
  });

  it("holds every row's category picker until a bulk save finishes", async () => {
    const save = Promise.withResolvers<Response>();
    respond((_url, init) =>
      init?.method === "PUT" ? save.promise : Response.json(listing),
    );
    await mountFinance();
    await check("Select Coffee");
    await setBulkCategory("meals");
    const picker = (name: string) =>
      container.querySelector<HTMLSelectElement>(
        `[aria-label="Expense category for ${name}"]`,
      );
    expect(picker("Lunch")?.disabled).toBe(true);
    expect(checkbox("Select Lunch").disabled).toBe(true);
    await act(async () =>
      save.resolve(
        Response.json({
          expenseCategoryId: "meals",
          transactionIds: ["Coffee"],
        }),
      ),
    );
    expect(picker("Lunch")?.disabled).toBe(false);
    expect(categoryOf("Coffee")).toBe("meals");
  });

  it("saves more than one request's worth of rows in batches", async () => {
    const many = Array.from({ length: 251 }, (_, index) =>
      transaction(`Row ${index}`),
    );
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
    await check("Select all shown transactions");
    expect(container.textContent).toContain("251 selected");
    await setBulkCategory("meals");
    expect(saves.map((ids) => ids.length)).toEqual([250, 1]);
    expect(saves.flat()).toEqual(many.map(({ id }) => id));
  });
});

it("polls status without loading history until completion or discarding an in-flight page", async () => {
  using polls = holdTimers(syncPollMs);
  const older = Promise.withResolvers<Response>();
  let firstPageRequests = 0;
  let statusRequests = 0;
  let finished = false;
  const listing: FinanceData = {
    ...data,
    nextCursor: "older",
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
    if (url.searchParams.has("cursor")) return older.promise;
    firstPageRequests++;
    return Response.json(finished ? { ...listing, connections: [] } : listing);
  });
  await mountFinance();
  await click("Load more transactions");
  await polls.fire();
  expect(firstPageRequests).toBe(1);
  await act(async () =>
    older.resolve(
      Response.json({
        ...listing,
        nextCursor: null,
        transactions: [transaction("Older expense")],
      }),
    ),
  );
  expect(rowNames()).toEqual(["Coffee", "Supplies", "Older expense"]);
  await polls.fire();
  expect(statusRequests).toBe(1);
  expect(firstPageRequests).toBe(1);
  finished = true;
  await polls.fire();
  expect(firstPageRequests).toBe(2);
  expect(rowNames()).toEqual(["Coffee", "Supplies", "Older expense"]);
});
