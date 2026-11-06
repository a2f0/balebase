import type { FinanceTransaction } from "@balebase/validators/finance";

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
 * description), most transactions first, then by name.
 */
export function groupByPayee(transactions: FinanceTransaction[]) {
  const groups = new Map<string, PayeeGroup & { mixed: boolean }>();
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
  return [...groups.values()]
    .map(
      ({ mixed, ...group }): PayeeGroup =>
        mixed
          ? { ...group, currencyCode: null, total: null }
          : { ...group, total: roundCents(group.total ?? 0) },
    )
    .sort(
      (a, b) =>
        b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/**
 * Sums of cents carry float error (0.1 + 0.2); amounts have two places.
 * Adding zero turns -0 (a refund that cancels a charge) into 0.
 */
function roundCents(value: number) {
  return Math.round(value * 100) / 100 + 0;
}
