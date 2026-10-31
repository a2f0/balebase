import { financeRoutes } from "@balebase/validators/finance";
import { activityCursor, type McpTool } from "./mcpToolSchema";

const categoryName = {
  name: "Category name, unique in the organization; repeated spaces collapse.",
};
const transactionId = {
  id: "Transaction id from get_finance_overview or search_finance_transactions.",
};
const categoryId = { id: "Category id from list_expense_categories." };
const connectionId = { id: "Connection id from get_finance_overview." };

export const financeTools: McpTool[] = [
  {
    description:
      "Gets connected bank institutions, accounts and balances, expense categories, and the 250 newest transactions with notes, labels, categories, and linked emails. Filters narrow the transactions; pass nextCursor for the next 250.",
    descriptions: {
      accountId: "Account id, or a list of them; omit for every account.",
      category: "Expense category slug from list_expense_categories.",
      cursor: "The nextCursor from the previous page; omit for the newest.",
      uncategorized: '"true" for uncategorized spending only.',
      year: "Four-digit year of the transaction date, such as 2026.",
    },
    name: "get_finance_overview",
    // Clients before 0.1.52 filter by category id; category replaces it.
    omit: ["categoryId"],
    route: financeRoutes.listing,
    title: "Get finance overview",
  },
  {
    description:
      "Finds up to 25 recent transactions whose name or merchant contains the query, or whose amount matches it (for example 42.50 or $1,200).",
    descriptions: { q: "Search text or amount; empty returns the newest." },
    name: "search_finance_transactions",
    route: financeRoutes.searchTransactions,
    title: "Search finance transactions",
  },
  {
    description:
      "Lists expense categories with their URL slugs and how many transactions each has.",
    name: "list_expense_categories",
    route: financeRoutes.listCategories,
    title: "List expense categories",
  },
  {
    description:
      "Totals posted spending by category and currency for an inclusive date range. Refunds reduce their category; uncategorized transfers and loan payments are reported separately.",
    descriptions: {
      from: "First day, YYYY-MM-DD; omit for no lower bound.",
      to: "Last day, YYYY-MM-DD; omit for no upper bound.",
    },
    name: "get_expense_report",
    route: financeRoutes.expenseReport,
    title: "Get expense report",
  },
  {
    description:
      "Queues a durable background sync from Plaid for one bank connection and returns its job. Use get_finance_sync_status to check completion; leaving the session does not stop it.",
    descriptions: connectionId,
    name: "sync_finance_connection",
    openWorld: true,
    route: financeRoutes.startSync,
    title: "Sync finance connection",
  },
  {
    description:
      "Gets the latest background sync job and connection status without loading transactions.",
    descriptions: connectionId,
    name: "get_finance_sync_status",
    route: financeRoutes.syncStatus,
    title: "Get finance sync status",
  },
  {
    description:
      "Gets Plaid's live health for a connection's bank across all Plaid users, with logins (including repairs) and transaction updates reported separately as percentages of recent requests. Null fields mean unknown, not healthy. Answers are reused for up to five minutes.",
    descriptions: connectionId,
    name: "get_finance_institution_health",
    openWorld: true,
    route: financeRoutes.institutionHealth,
    title: "Get finance institution health",
  },
  {
    description:
      "Lists one bank connection's history, newest first, 50 events per page: who connected it, requested syncs, changed daily sync, or disconnected it. Works for disconnected connections. Pass nextCursor to page.",
    descriptions: { ...connectionId, ...activityCursor },
    name: "list_finance_connection_activity",
    route: financeRoutes.connectionActivity,
    title: "List finance connection activity",
  },
  {
    description:
      "Replaces a transaction's note, labels, and reviewed flag. Send the current values for anything that should stay.",
    descriptions: {
      ...transactionId,
      labels: "Labels; this replaces the current labels.",
      note: "Note; this replaces the current note.",
      reviewed: "Whether the transaction has been reviewed.",
    },
    name: "annotate_finance_transaction",
    route: financeRoutes.updateTransactionAnnotation,
    title: "Annotate finance transaction",
  },
  {
    description: "Assigns a transaction to an expense category.",
    descriptions: {
      ...transactionId,
      categoryId: "Category id, or null to uncategorize.",
    },
    name: "categorize_finance_transaction",
    route: financeRoutes.setTransactionCategory,
    title: "Categorize finance transaction",
  },
  {
    description: "Creates an expense category.",
    descriptions: categoryName,
    name: "create_expense_category",
    route: financeRoutes.createCategory,
    title: "Create expense category",
  },
  {
    description:
      "Adds the common set of expense categories, skipping names that already exist.",
    name: "add_default_expense_categories",
    route: financeRoutes.addDefaultCategories,
    title: "Add default expense categories",
  },
  {
    description: "Renames an expense category.",
    descriptions: { ...categoryId, ...categoryName },
    name: "rename_expense_category",
    route: financeRoutes.renameCategory,
    title: "Rename expense category",
  },
  {
    description:
      "Deletes an expense category; its transactions become uncategorized.",
    descriptions: categoryId,
    destructive: true,
    name: "delete_expense_category",
    route: financeRoutes.deleteCategory,
    title: "Delete expense category",
  },
];
