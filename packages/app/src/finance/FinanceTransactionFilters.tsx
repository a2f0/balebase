import type { FinanceFilters } from "@balebase/api-client";
import { Button } from "@balebase/ui/react";
import type { ExpenseCategory } from "@balebase/validators/finance";
import { FinancePeriodFilter } from "./FinancePeriodFilter";

/** Whether any filter narrows the transaction list. */
export function hasTransactionFilters(filters: FinanceFilters) {
  return (
    filters.accountIds.length > 0 ||
    filters.categorySlug !== null ||
    filters.name !== null ||
    filters.year !== null ||
    filters.uncategorized
  );
}

export function FinanceTransactionFilters({
  categories,
  filters,
  onChange,
  onClear,
  searchActive,
}: {
  categories: ExpenseCategory[];
  filters: FinanceFilters;
  onChange: (filters: FinanceFilters) => void;
  onClear: () => void;
  searchActive: boolean;
}) {
  const categoryName = filters.categorySlug
    ? (categories.find(({ slug }) => slug === filters.categorySlug)?.name ??
      filters.categorySlug)
    : undefined;
  return (
    <div className="financeTransactionFilters">
      <FinancePeriodFilter
        onChange={(year) => onChange({ ...filters, year })}
        year={filters.year}
      />
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
      {filters.name !== null && (
        <Button
          aria-pressed
          iconEnd="close"
          onClick={() => onChange({ ...filters, name: null })}
          size="sm"
          variant="primary"
        >
          Name: {filters.name}
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
      {(hasTransactionFilters(filters) || searchActive) && (
        <Button icon="close" onClick={onClear} size="sm" variant="ghost">
          Clear filters
        </Button>
      )}
    </div>
  );
}
