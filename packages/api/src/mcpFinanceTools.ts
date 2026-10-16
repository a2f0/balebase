import {
  boolean,
  date,
  id,
  list,
  type McpTool,
  nullable,
  text,
} from "./mcpToolSchema";

const categoryName = text(
  "Category name, unique in the organization; repeated spaces collapse.",
  { maxLength: 60, minLength: 1 },
);
const transactionId = id(
  "Transaction id from get_finance_overview or search_finance_transactions.",
);
const categoryId = id("Category id from list_expense_categories.");

export const financeTools: McpTool[] = [
  {
    description:
      "Gets connected bank institutions, accounts and balances, expense categories, and the 250 newest transactions with notes, labels, categories, and linked emails.",
    method: "GET",
    name: "get_finance_overview",
    path: "/api/finance",
    title: "Get finance overview",
  },
  {
    description:
      "Finds up to 25 recent transactions whose name or merchant contains the query, or whose amount matches it (for example 42.50 or $1,200).",
    method: "GET",
    name: "search_finance_transactions",
    path: "/api/finance/transactions",
    query: {
      q: text("Search text or amount; empty returns the newest.", {
        maxLength: 100,
      }),
    },
    title: "Search finance transactions",
  },
  {
    description:
      "Lists expense categories with how many transactions each has.",
    method: "GET",
    name: "list_expense_categories",
    path: "/api/finance/categories",
    title: "List expense categories",
  },
  {
    description:
      "Totals posted spending by category and currency for an inclusive date range. Refunds reduce their category; uncategorized transfers and loan payments are reported separately.",
    method: "GET",
    name: "get_expense_report",
    path: "/api/finance/reports/expenses",
    query: {
      from: date("First day, YYYY-MM-DD; omit for no lower bound."),
      to: date("Last day, YYYY-MM-DD; omit for no upper bound."),
    },
    title: "Get expense report",
  },
  {
    description:
      "Imports new, changed, and removed transactions from Plaid for one bank connection.",
    method: "POST",
    name: "sync_finance_connection",
    openWorld: true,
    params: {
      id: id("Connection id from get_finance_overview."),
    },
    path: "/api/finance/connections/{id}/sync",
    title: "Sync finance connection",
  },
  {
    body: {
      properties: {
        labels: list(
          "Labels; this replaces the current labels.",
          text("A label.", { maxLength: 50 }),
          { maxItems: 12 },
        ),
        note: text("Note; this replaces the current note.", {
          maxLength: 2000,
        }),
        reviewed: boolean("Whether the transaction has been reviewed."),
      },
      required: ["note", "labels", "reviewed"],
    },
    description:
      "Replaces a transaction's note, labels, and reviewed flag. Send the current values for anything that should stay.",
    method: "PATCH",
    name: "annotate_finance_transaction",
    params: { id: transactionId },
    path: "/api/finance/transactions/{id}/annotation",
    title: "Annotate finance transaction",
  },
  {
    body: {
      properties: {
        categoryId: nullable(
          text("Category id, or null to uncategorize.", {
            maxLength: 100,
            minLength: 1,
          }),
        ),
      },
      required: ["categoryId"],
    },
    description: "Assigns a transaction to an expense category.",
    method: "PUT",
    name: "categorize_finance_transaction",
    params: { id: transactionId },
    path: "/api/finance/transactions/{id}/category",
    title: "Categorize finance transaction",
  },
  {
    body: { properties: { name: categoryName }, required: ["name"] },
    description: "Creates an expense category.",
    method: "POST",
    name: "create_expense_category",
    path: "/api/finance/categories",
    title: "Create expense category",
  },
  {
    description:
      "Adds the common set of expense categories, skipping names that already exist.",
    method: "POST",
    name: "add_default_expense_categories",
    path: "/api/finance/categories/defaults",
    title: "Add default expense categories",
  },
  {
    body: { properties: { name: categoryName }, required: ["name"] },
    description: "Renames an expense category.",
    method: "PATCH",
    name: "rename_expense_category",
    params: { id: categoryId },
    path: "/api/finance/categories/{id}",
    title: "Rename expense category",
  },
  {
    description:
      "Deletes an expense category; its transactions become uncategorized.",
    destructive: true,
    method: "DELETE",
    name: "delete_expense_category",
    params: { id: categoryId },
    path: "/api/finance/categories/{id}",
    title: "Delete expense category",
  },
];
