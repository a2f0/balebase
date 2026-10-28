/** "1 audit", "3 audits"; pass the plural when appending "s" is wrong. */
export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Display text for a machine value, e.g. "in_progress" → "In progress" or
 * Plaid's "FOOD_AND_DRINK" → "Food and drink".
 */
export function formatLabel(value: string) {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "512 B", "3.4 KB", "12.0 MB". */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A moment's date in the viewer's time zone, such as "Mar 1, 2026". */
export function formatDate(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

/** A moment's date and time in the viewer's time zone. */
export function formatDateTime(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** A moment's day and month, such as "Mar 1", for compact lists. */
export function formatShortDate(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

/**
 * A YYYY-MM-DD calendar day, such as a due date. It names a day rather than
 * an instant, so it is read and shown in UTC to stay the same day in every
 * time zone. Unexpected values are shown as given.
 */
export function formatCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    timeZone: "UTC",
  }).format(date);
}
