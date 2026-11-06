import { Badge, Button, Card, cx } from "@balebase/ui/react";
import { countLabel, formatCalendarDate } from "../shared/labels";
import { formatMoney } from "./financeFormat";
import type { PayeeGroup } from "./payeeGroups";

/** How the Transactions section lists what the filters match. */
export type TransactionView = "list" | "payees";

/** One row per payee; choosing one lists its transactions. */
export function FinancePayeeList({
  onSelect,
  payees,
}: {
  onSelect: (name: string) => void;
  payees: PayeeGroup[];
}) {
  return (
    <Card className="financeListCard" flush>
      <ul aria-label="Payees" className="rowList financePayees">
        {payees.map((payee) => (
          // The name's button covers the whole row, so any click there opens it.
          <li className="row rowInteractive financePayee" key={payee.name}>
            <div className="rowMain">
              <Button
                aria-label={`Show transactions for ${payee.name}`}
                className="rowTitle rowTarget financePayeeName"
                onClick={() => onSelect(payee.name)}
                variant="link"
              >
                {payee.name}
              </Button>
              <span className="rowMeta">
                {countLabel(payee.count, "transaction")} · Latest{" "}
                {formatCalendarDate(payee.latestDate)}
              </span>
            </div>
            {payee.pending > 0 && (
              <Badge tone="warning">{payee.pending} pending</Badge>
            )}
            <span
              className={cx(
                "financeAmount",
                payee.total !== null &&
                  payee.total > 0 &&
                  "financeAmountCredit",
              )}
            >
              {payee.total === null
                ? "Several currencies"
                : formatMoney(payee.total, payee.currencyCode)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Switches the Transactions section between rows and payee totals. */
export function TransactionViewSwitch({
  onChange,
  view,
}: {
  onChange: (view: TransactionView) => void;
  view: TransactionView;
}) {
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Transaction view</legend>
      {(
        [
          ["list", "Transactions"],
          ["payees", "By payee"],
        ] as const
      ).map(([value, label]) => (
        <button
          aria-pressed={view === value}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}
