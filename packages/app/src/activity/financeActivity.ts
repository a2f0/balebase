import type { ActivityEvent } from "@balebase/validators/activity";
import { countLabel } from "../shared/labels";
import { textValue } from "./activityLabels";

/** Labels for the bank connection, expense category, and billing events. */
export const financeActionLabels: Record<string, string> = {
  "billing.checkout_started": "started Pro checkout",
  "finance.categories_defaults_added": "added the common expense categories",
  "finance.category_created": "created an expense category",
  "finance.category_deleted": "deleted an expense category",
  "finance.category_renamed": "renamed an expense category",
  "finance.connection_created": "connected a bank",
  "finance.connection_data_deleted": "deleted a bank's imported data",
};

function count(value: unknown, singular: string) {
  return countLabel(typeof value === "number" ? value : 0, singular);
}

const summaries: Partial<Record<string, (event: ActivityEvent) => string>> = {
  "billing.checkout_started": ({ details }) =>
    `Pro for ${count(details.quantity, "seat")}`,
  "finance.categories_defaults_added": ({ details }) =>
    Array.isArray(details.names) ? details.names.map(textValue).join(", ") : "",
  "finance.category_created": ({ details }) => textValue(details.name),
  "finance.category_deleted": ({ details }) =>
    `${textValue(details.name)} · ${count(details.transactionCount, "transaction")} left uncategorized`,
  "finance.category_renamed": ({ details }) =>
    `${textValue(details.beforeName)} → ${textValue(details.afterName)}`,
  "finance.connection_created": ({ details, root }) =>
    textValue(details.institutionName) || root.label,
  "finance.daily_sync_changed": ({ details }) =>
    `Daily sync ${details.before ? "on" : "off"} → ${details.after ? "on" : "off"}`,
  "finance.connection_data_deleted": ({ details }) =>
    `Deleted ${count(details.accountCount, "account")}, ${count(details.transactionCount, "transaction")}, and ${count(details.annotationCount, "annotation")}`,
};

/** A one-line summary of a bank connection, category, or billing event. */
export function financeActivitySummary(event: ActivityEvent) {
  return summaries[event.action]?.(event);
}
