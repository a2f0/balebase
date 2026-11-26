import type {
  ExpenseCategory,
  FinanceTransaction,
} from "@balebase/validators/finance";

/** A transaction moved from one category (or none) to another. */
export interface CategoryChange {
  from: string | null;
  id: string;
  to: string | null;
}

type YearCounts = ExpenseCategory["transactionCountsByYear"];
type YearCount = YearCounts[number];
export type CategoryTotals = YearCount["totals"];

/** What a transaction adds to its category's year. */
export type CountedTransaction = Pick<
  FinanceTransaction,
  "amount" | "currencyCode" | "transactionDate"
>;

/**
 * A category's per-year counts and totals after `changes` move transactions,
 * given each moved transaction (`moved`, by ID).
 */
export function categoryYearCounts(
  categoryId: string,
  // A copy saved before per-year counts existed has none.
  before: YearCounts | undefined,
  changes: CategoryChange[],
  moved: Map<string, CountedTransaction>,
): YearCounts {
  const years = new Map((before ?? []).map((entry) => [entry.year, entry]));
  for (const { from, id, to } of changes) {
    const transaction = moved.get(id);
    if (!transaction || from === to) continue;
    const step = to === categoryId ? 1 : from === categoryId ? -1 : 0;
    if (step) count(years, transaction, step);
  }
  return [...years.values()]
    .filter(({ transactionCount }) => transactionCount > 0)
    .sort((a, b) => a.year - b.year);
}

/** Counts and totals per year for transactions, as the API reports them. */
export function yearCountsOf(transactions: CountedTransaction[]): YearCounts {
  const years = new Map<number, YearCount>();
  for (const transaction of transactions) count(years, transaction, 1);
  return [...years.values()].sort((a, b) => a.year - b.year);
}

/** Totals summed across every year, or only `year`'s. */
export function periodTotals(
  years: YearCounts,
  year: number | null,
): CategoryTotals {
  const sums = new Map<string | null, number>();
  for (const entry of years) {
    if (year !== null && entry.year !== year) continue;
    for (const { currencyCode, total } of entry.totals)
      sums.set(currencyCode, (sums.get(currencyCode) ?? 0) + total);
  }
  return sortedTotals(sums);
}

function count(
  years: Map<number, YearCount>,
  transaction: CountedTransaction,
  step: 1 | -1,
) {
  const year = Number(transaction.transactionDate.slice(0, 4));
  const entry = years.get(year);
  const sums = new Map(
    (entry?.totals ?? []).map(({ currencyCode, total }) => [
      currencyCode,
      total,
    ]),
  );
  const currency = transaction.currencyCode;
  // Totals read as rows show amounts: spending negative.
  sums.set(currency, (sums.get(currency) ?? 0) - step * transaction.amount);
  years.set(year, {
    totals: sortedTotals(sums),
    transactionCount: (entry?.transactionCount ?? 0) + step,
    year,
  });
}

/**
 * Sums of decimal amounts carry float error (0.1 + 0.2). Amounts have at most
 * a currency's minor units (three for KWD), so six places keep every digit;
 * the API rounds the same way. Adding zero turns -0 into 0.
 */
function roundSum(value: number) {
  return Math.round(value * 1e6) / 1e6 + 0;
}

function sortedTotals(sums: Map<string | null, number>): CategoryTotals {
  return [...sums]
    .map(([currencyCode, total]) => ({
      currencyCode,
      total: roundSum(total),
    }))
    .sort((a, b) => (a.currencyCode ?? "").localeCompare(b.currencyCode ?? ""));
}
