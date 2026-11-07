import type { FinanceTransaction } from "@balebase/validators/finance";
import { useMemo } from "react";
import { formatMoney } from "./financeFormat";

/** Every matching transaction, including pending rows and those not yet shown. */
export function FinanceTransactionTotals({
  matching,
}: {
  matching: FinanceTransaction[];
}) {
  const totals = useMemo(() => totalsByCurrency(matching), [matching]);
  return (
    <dl
      aria-live="polite"
      aria-atomic="true"
      className="financeTransactionTotals"
    >
      {(["in", "out"] as const).map((direction) => (
        <div key={direction}>
          <dt>Money {direction}</dt>
          {totals.length ? (
            totals.map(([currency, amounts]) => (
              <dd key={currency ?? ""}>
                {formatMoney(
                  amounts[direction],
                  currency,
                  totals.length > 1 ? "code" : "narrowSymbol",
                )}
                {currency === null && " (unknown currency)"}
              </dd>
            ))
          ) : (
            <dd>{formatMoney(0, null)}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

function totalsByCurrency(transactions: FinanceTransaction[]) {
  const totals = new Map<string | null, { in: number; out: number }>();
  for (const { amount, currencyCode } of transactions) {
    const currency = currencyCode || null;
    let total = totals.get(currency);
    if (!total) {
      total = { in: 0, out: 0 };
      totals.set(currency, total);
    }
    // Plaid uses positive amounts for money out. Leave precision to the
    // currency formatter, including currencies with three decimal places.
    total[amount < 0 ? "in" : "out"] += Math.abs(amount);
  }
  return [...totals].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
}
