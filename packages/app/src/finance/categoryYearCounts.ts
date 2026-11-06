import type { ExpenseCategory } from "@balebase/validators/finance";

/** A transaction moved from one category (or none) to another. */
export interface CategoryChange {
  from: string | null;
  id: string;
  to: string | null;
}

type YearCounts = ExpenseCategory["transactionCountsByYear"];

/**
 * A category's per-year counts after `changes` move transactions, given each
 * moved transaction's year (`years`, by transaction ID).
 */
export function categoryYearCounts(
  categoryId: string,
  // A copy saved before per-year counts existed has none.
  before: YearCounts | undefined,
  changes: CategoryChange[],
  years: Map<string, number>,
): YearCounts {
  const counts = new Map<number, number>(
    (before ?? []).map(({ transactionCount, year }) => [
      year,
      transactionCount,
    ]),
  );
  for (const { from, id, to } of changes) {
    const year = years.get(id);
    if (year === undefined || from === to) continue;
    const step = to === categoryId ? 1 : from === categoryId ? -1 : 0;
    counts.set(year, (counts.get(year) ?? 0) + step);
  }
  return [...counts]
    .filter(([, transactionCount]) => transactionCount > 0)
    .sort(([a], [b]) => a - b)
    .map(([year, transactionCount]) => ({ transactionCount, year }));
}
