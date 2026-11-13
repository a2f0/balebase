import { Field, Select } from "@balebase/ui/react";
import { useId } from "react";
import {
  type TransactionView,
  TransactionViewSwitch,
} from "./FinancePayeeList";
import type { TransactionSort } from "./financeTransactions";
import type { PayeeSort } from "./payeeGroups";

/** Local browsing preferences, independent of the saved transaction filters. */
export function FinanceTransactionControls({
  onSearchChange,
  onSortChange,
  onViewChange,
  search,
  sort,
  view,
}: {
  onSearchChange: (search: string) => void;
  onSortChange: (sort: TransactionSort | PayeeSort) => void;
  onViewChange: (view: TransactionView) => void;
  search: string;
  sort: TransactionSort | PayeeSort;
  view: TransactionView;
}) {
  const hintId = useId();
  const sortLabel = view === "payees" ? "Sort payees" : "Sort transactions";
  return (
    <div className="financeTransactionControls">
      <TransactionViewSwitch onChange={onViewChange} view={view} />
      <Field className="financeTransactionSearch" label="Search transactions">
        <input
          aria-label="Search transactions"
          aria-describedby={hintId}
          className="input"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Payee or bank description"
          type="search"
          value={search}
        />
        <span className="fieldHint" id={hintId}>
          Matches part of a payee or original bank description.
        </span>
      </Field>
      <Field className="financeTransactionSort" label={sortLabel}>
        <Select
          onChange={(event) =>
            onSortChange(event.target.value as TransactionSort | PayeeSort)
          }
          value={sort}
        >
          {view === "payees" ? (
            <option value="count">Most transactions</option>
          ) : (
            <option value="newest">Newest first</option>
          )}
          <option value="payee">Payee: A to Z</option>
          <option value="-payee">Payee: Z to A</option>
          {view === "payees" && (
            <>
              <option value="total">Total: low to high</option>
              <option value="-total">Total: high to low</option>
            </>
          )}
        </Select>
      </Field>
    </div>
  );
}
