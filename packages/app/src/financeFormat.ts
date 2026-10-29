import { countLabel, formatCalendarDate } from "./shared/labels";

/** Formats an amount in its currency, or as a plain number without one. */
export function formatMoney(value: number | null, currency: string | null) {
  if (value === null) return "—";
  if (!currency) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    currency,
    currencyDisplay: "narrowSymbol",
    style: "currency",
  }).format(value);
}

/** "42 transactions · Jan 3, 2025 – Oct 17, 2026" for imported history. */
export function formatImportedHistory(history: {
  count: number;
  firstDate: string | null;
  lastDate: string | null;
}) {
  const count = countLabel(history.count, "transaction");
  return history.firstDate && history.lastDate
    ? `${count} · ${formatCalendarDate(history.firstDate)} – ${formatCalendarDate(history.lastDate)}`
    : count;
}
