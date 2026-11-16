import type { FinancePeriod } from "@balebase/validators/rules";
import { financePeriodLabels, financePeriodYear } from "./financePeriod";

const shown: FinancePeriod[] = ["allTime", "currentYear", "previousYear"];

/**
 * Finance's period choice: every transaction, or those dated in the current
 * or previous calendar year (local time). The overview's transactions and
 * Categories' counts share it.
 */
export function FinancePeriodFilter({
  onChange,
  year,
}: {
  onChange: (year: number | null) => void;
  year: number | null;
}) {
  const today = new Date();
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Transaction period</legend>
      {shown.map((period) => {
        const value = financePeriodYear(period, today);
        return (
          <button
            aria-pressed={year === value}
            key={period}
            onClick={() => onChange(value)}
            type="button"
          >
            {financePeriodLabels[period]}
          </button>
        );
      })}
    </fieldset>
  );
}
