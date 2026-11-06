import type {
  ExpenseCategory,
  FinanceData,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { yearCountsOf } from "./categoryYearCounts";

type Summary = Omit<FinanceData, "nextCursor" | "transactions">;
type YearCount = ExpenseCategory["transactionCountsByYear"][number];

/**
 * A category as saved by an earlier release: before per-year counts, or
 * before those years carried totals.
 */
type SavedCategory = Omit<ExpenseCategory, "transactionCountsByYear"> & {
  transactionCountsByYear?: (Omit<YearCount, "totals"> &
    Partial<Pick<YearCount, "totals">>)[];
};

function current(category: SavedCategory): category is ExpenseCategory {
  return Boolean(
    category.transactionCountsByYear?.every((entry) => entry.totals),
  );
}

/**
 * A summary saved on this device, with per-year category counts and totals
 * rebuilt from the saved transactions where an earlier release saved them
 * without, so a saved copy shown before the next load still counts and sums
 * by period.
 */
export function savedSummary<T extends Summary>(
  summary: T | null,
  transactions: FinanceTransaction[],
): T | null {
  const categories: SavedCategory[] | undefined = summary?.categories;
  if (!summary || !categories || categories.every(current)) return summary;
  const byCategory = Map.groupBy(
    transactions.filter(({ expenseCategoryId }) => expenseCategoryId),
    ({ expenseCategoryId }) => expenseCategoryId,
  );
  return {
    ...summary,
    categories: categories.map((category) =>
      current(category)
        ? category
        : {
            ...category,
            transactionCountsByYear: yearCountsOf(
              byCategory.get(category.id) ?? [],
            ),
          },
    ),
  };
}
