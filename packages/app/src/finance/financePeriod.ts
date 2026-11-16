import { type FinancePeriod, financePeriods } from "@balebase/validators/rules";

/** Each period's name, on the period filter and in Account settings alike. */
export const financePeriodLabels: Record<FinancePeriod, string> = {
  allTime: "All time",
  currentYear: "Current year",
  previousYear: "Previous year",
};

/** The period the session names; anything else is every transaction. */
export function financePeriodOf(value: unknown): FinancePeriod {
  return financePeriods.find((period) => period === value) ?? "allTime";
}

/** The calendar year (local time) `period` filters to; null for all time. */
export function financePeriodYear(
  period: FinancePeriod,
  today = new Date(),
): number | null {
  switch (period) {
    case "allTime":
      return null;
    case "currentYear":
      return today.getFullYear();
    case "previousYear":
      return today.getFullYear() - 1;
  }
}
