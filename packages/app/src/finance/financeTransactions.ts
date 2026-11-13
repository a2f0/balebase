import type { FinanceFilters } from "@balebase/api-client";
import type {
  ExpenseCategory,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { transactionTitle } from "./payeeGroups";

export type TransactionSort = "newest" | "payee" | "-payee";

/** Search the displayed payee and original bank description literally. */
export function searchTransactions(
  transactions: FinanceTransaction[],
  search: string,
): FinanceTransaction[] {
  if (!search) return transactions;
  const query = search.toLowerCase();
  return transactions.filter(
    (transaction) =>
      transaction.name.toLowerCase().includes(query) ||
      Boolean(transaction.merchantName?.toLowerCase().includes(query)),
  );
}

/** Sort cached rows without changing their source order. */
export function sortTransactions(
  transactions: FinanceTransaction[],
  sort: TransactionSort,
): FinanceTransaction[] {
  if (sort === "newest") return [...transactions].sort(newestFirst);
  const direction = sort === "payee" ? 1 : -1;
  return transactions
    .map((transaction) => ({
      transaction,
      name: transactionTitle(transaction).toLowerCase(),
    }))
    .sort((a, b) => {
      const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      return direction * byName || newestFirst(a.transaction, b.transaction);
    })
    .map(({ transaction }) => transaction);
}

/** Ordinary clicks focus one account; Shift toggles it within the selection. */
export function selectFinanceAccount(
  selected: string[],
  accountId: string,
  shiftKey: boolean,
) {
  if (shiftKey) {
    return selected.includes(accountId)
      ? selected.filter((id) => id !== accountId)
      : [...selected, accountId];
  }
  return selected.length === 1 && selected[0] === accountId ? [] : [accountId];
}

/** Plaid categories that move money rather than spend it (financeReports.ts). */
const transferCategories = new Set(["TRANSFER_OUT", "LOAN_PAYMENTS"]);

/**
 * The saved transactions the filters show, newest first. These are the rules
 * the API's listing applies (financeListingFilters.ts): keep them together.
 */
export function filterTransactions(
  transactions: FinanceTransaction[],
  filters: FinanceFilters,
  categories: ExpenseCategory[],
) {
  const categoryId = filters.categorySlug
    ? (categories.find(({ slug }) => slug === filters.categorySlug)?.id ?? "")
    : undefined;
  const year = filters.year ? String(filters.year) : undefined;
  return transactions
    .filter(
      (transaction) =>
        (!filters.accountIds.length ||
          filters.accountIds.includes(transaction.accountId)) &&
        (!year || transaction.transactionDate.startsWith(`${year}-`)) &&
        (!filters.uncategorized || uncategorizedExpense(transaction)) &&
        (categoryId === undefined ||
          transaction.expenseCategoryId === categoryId) &&
        (!filters.name ||
          (transaction.merchantName ?? transaction.name) === filters.name),
    )
    .sort(newestFirst);
}

/** The listing's order: date, then ID, both descending. */
export function newestFirst(a: FinanceTransaction, b: FinanceTransaction) {
  if (a.transactionDate !== b.transactionDate)
    return a.transactionDate < b.transactionDate ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function uncategorizedExpense(transaction: FinanceTransaction) {
  return (
    !transaction.expenseCategoryId &&
    !transaction.pending &&
    transaction.amount > 0 &&
    !transferCategories.has(transaction.categoryPrimary ?? "")
  );
}
