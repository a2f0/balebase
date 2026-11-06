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
  const current = new Date().getFullYear();
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Transaction period</legend>
      {[
        { label: "All time", year: null },
        { label: "Current year", year: current },
        { label: "Previous year", year: current - 1 },
      ].map((item) => (
        <button
          aria-pressed={year === item.year}
          key={item.label}
          onClick={() => onChange(item.year)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
