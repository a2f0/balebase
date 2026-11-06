import type {
  ExpenseCategory,
  FinanceData,
  FinanceTransaction,
} from "@balebase/validators/finance";

type Summary = Omit<FinanceData, "nextCursor" | "transactions">;

/** A category as saved by a release before per-year counts existed. */
type SavedCategory = Omit<ExpenseCategory, "transactionCountsByYear"> &
  Partial<Pick<ExpenseCategory, "transactionCountsByYear">>;

/**
 * A summary saved on this device, with per-year category counts filled in
 * from the saved transactions where an earlier release saved none, so a
 * saved copy shown before the next load still counts by period.
 */
export function savedSummary<T extends Summary>(
  summary: T | null,
  transactions: FinanceTransaction[],
): T | null {
  const categories: SavedCategory[] | undefined = summary?.categories;
  if (
    !summary ||
    !categories?.some((category) => !category.transactionCountsByYear)
  )
    return summary;
  const counts = new Map<string, Map<number, number>>();
  for (const { expenseCategoryId, transactionDate } of transactions) {
    if (!expenseCategoryId) continue;
    const years = counts.get(expenseCategoryId) ?? new Map<number, number>();
    const year = Number(transactionDate.slice(0, 4));
    years.set(year, (years.get(year) ?? 0) + 1);
    counts.set(expenseCategoryId, years);
  }
  return {
    ...summary,
    categories: categories.map((category) => ({
      ...category,
      transactionCountsByYear:
        category.transactionCountsByYear ??
        [...(counts.get(category.id) ?? [])]
          .sort(([a], [b]) => a - b)
          .map(([year, transactionCount]) => ({ transactionCount, year })),
    })),
  };
}
