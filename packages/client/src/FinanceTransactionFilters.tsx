import { Button } from "@balebase/ui/react";
import type { FinanceFilters } from "./financeApi";

export function FinanceTransactionFilters({
  filters,
  onChange,
}: {
  filters: FinanceFilters;
  onChange: (filters: FinanceFilters) => void;
}) {
  const year = new Date().getFullYear();
  return (
    <div className="financeTransactionFilters">
      <fieldset className="segmented">
        <legend className="srOnly">Transaction period</legend>
        {[
          { label: "All time", year: null },
          { label: "Current year", year },
          { label: "Previous year", year: year - 1 },
        ].map((item) => (
          <button
            aria-pressed={filters.year === item.year}
            key={item.label}
            onClick={() => onChange({ ...filters, year: item.year })}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <Button
        aria-pressed={filters.uncategorized}
        onClick={() =>
          onChange({ ...filters, uncategorized: !filters.uncategorized })
        }
        size="sm"
        variant={filters.uncategorized ? "primary" : "secondary"}
      >
        Uncategorized expenses
      </Button>
      {(filters.accountIds.length > 0 ||
        filters.year !== null ||
        filters.uncategorized) && (
        <Button
          icon="close"
          onClick={() =>
            onChange({ accountIds: [], year: null, uncategorized: false })
          }
          size="sm"
          variant="ghost"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
