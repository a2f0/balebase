import { countLabel } from "./labels";

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

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Transaction dates are calendar days; noon keeps them in every time zone. */
export function formatDay(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00`),
  );
}

/** "42 transactions · Jan 3, 2025 – Oct 17, 2026" for imported history. */
export function formatImportedHistory(history: {
  count: number;
  firstDate: string | null;
  lastDate: string | null;
}) {
  const count = countLabel(history.count, "transaction");
  return history.firstDate && history.lastDate
    ? `${count} · ${formatDay(history.firstDate)} – ${formatDay(history.lastDate)}`
    : count;
}
