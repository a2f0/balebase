import type { FinanceTransaction } from "@balebase/validators/finance";

export type PayeeSort = "count" | "payee" | "-payee" | "total" | "-total";

/** The name a row shows, and the one the same-name filter matches. */
export function transactionTitle(transaction: FinanceTransaction) {
  return transaction.merchantName ?? transaction.name;
}

/** The transactions shown under one name, summed. */
export interface PayeeGroup {
  name: string;
  count: number;
  pending: number;
  /** The amounts' sum as rows show them (spending negative); null across currencies. */
  total: number | null;
  currencyCode: string | null;
  latestDate: string;
}

/**
 * Groups transactions by the name rows show (the merchant, else the bank's
 * description). By default, most transactions first, then by name.
 */
export function groupByPayee(
  transactions: FinanceTransaction[],
  sort: PayeeSort = "count",
) {
  const groups = new Map<
    string,
    PayeeGroup & { mixed: boolean; sortName: string }
  >();
  for (const transaction of transactions) {
    const name = transactionTitle(transaction);
    const group = groups.get(name);
    if (!group) {
      groups.set(name, {
        count: 1,
        currencyCode: transaction.currencyCode,
        latestDate: transaction.transactionDate,
        mixed: false,
        name,
        sortName: sort === "count" ? name : name.toLowerCase(),
        pending: transaction.pending ? 1 : 0,
        total: -transaction.amount,
      });
      continue;
    }
    group.count++;
    if (transaction.pending) group.pending++;
    if (transaction.transactionDate > group.latestDate)
      group.latestDate = transaction.transactionDate;
    group.mixed ||= transaction.currencyCode !== group.currencyCode;
    group.total = (group.total ?? 0) - transaction.amount;
  }
  for (const group of groups.values()) {
    if (group.mixed) {
      group.currencyCode = null;
      group.total = null;
    } else {
      group.total = roundCents(group.total ?? 0);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      const byExactName = compareNames(a.name, b.name);
      if (sort === "count") return b.count - a.count || byExactName;
      const byName = compareNames(a.sortName, b.sortName) || byExactName;
      if (sort === "payee") return byName;
      if (sort === "-payee") return -byName;
      if (a.total === null) return b.total === null ? byName : 1;
      if (b.total === null) return -1;
      const byTotal = a.total - b.total;
      return (sort === "total" ? byTotal : -byTotal) || byName;
    })
    .map(({ mixed: _mixed, sortName: _sortName, ...group }) => group);
}

function compareNames(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sums of cents carry float error (0.1 + 0.2); amounts have two places.
 * Adding zero turns -0 (a refund that cancels a charge) into 0.
 */
function roundCents(value: number) {
  return Math.round(value * 100) / 100 + 0;
}
