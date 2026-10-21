import { Button } from "@balebase/ui/react";
import type { ExpenseCategory, FinanceFilters } from "./financeApi";
import { initialFilters } from "./useFinanceData";

export function FinanceTransactionFilters({
  categories,
  filters,
  onChange,
}: {
  categories: ExpenseCategory[];
  filters: FinanceFilters;
  onChange: (filters: FinanceFilters) => void;
}) {
  const year = new Date().getFullYear();
  const categoryName = filters.categorySlug
    ? (categories.find(({ slug }) => slug === filters.categorySlug)?.name ??
      filters.categorySlug)
    : undefined;
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
      {categoryName && (
        <Button
          aria-pressed
          iconEnd="close"
          onClick={() => onChange({ ...filters, categorySlug: null })}
          size="sm"
          variant="primary"
        >
          Category: {categoryName}
        </Button>
      )}
      <Button
        aria-pressed={filters.uncategorized}
        onClick={() =>
          onChange({
            ...filters,
            categorySlug: null,
            uncategorized: !filters.uncategorized,
          })
        }
        size="sm"
        variant={filters.uncategorized ? "primary" : "secondary"}
      >
        Uncategorized expenses
      </Button>
      {(filters.accountIds.length > 0 ||
        filters.categorySlug !== null ||
        filters.year !== null ||
        filters.uncategorized) && (
        <Button
          icon="close"
          onClick={() => onChange(initialFilters)}
          size="sm"
          variant="ghost"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
