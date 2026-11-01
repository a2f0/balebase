import type { ActivityEvent } from "@balebase/validators/activity";
import { countLabel, formatDate, formatLabel } from "../shared/labels";
import { textValue } from "./activityLabels";

/**
 * Labels for the bank connection, expense category, and billing events,
 * including those Stripe and Plaid make.
 */
export const financeActionLabels: Record<string, string> = {
  "billing.checkout_started": "started Pro checkout",
  "billing.seats_changed": "changed the subscription's seats",
  "billing.subscription_changed": "updated the Pro subscription",
  "finance.categories_defaults_added": "added the common expense categories",
  "finance.category_created": "created an expense category",
  "finance.category_deleted": "deleted an expense category",
  "finance.category_renamed": "renamed an expense category",
  "finance.connection_created": "connected a bank",
  "finance.connection_data_deleted": "deleted a bank's imported data",
  "finance.connection_status_changed": "changed the bank connection's status",
  "finance.records_carried_over":
    "carried over accounts and transactions from a disconnected bank",
  "finance.transactions_removed": "removed transactions",
};

function count(value: unknown, singular: string) {
  return countLabel(typeof value === "number" ? value : 0, singular);
}

interface SubscriptionState {
  cancelAtPeriodEnd?: unknown;
  periodEnd?: unknown;
  seats?: unknown;
  status?: unknown;
}

interface ConnectionState {
  errorCode?: unknown;
  status?: unknown;
}

/** A recorded object detail, such as a before or after state. */
function state<T extends object>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null;
}

/** What Stripe changed: status, seats, cancellation, and the period end. */
function subscriptionSummary({ details }: ActivityEvent) {
  const before = state<SubscriptionState>(details.before);
  const after = state<SubscriptionState>(details.after) ?? {};
  const parts: string[] = [];
  const status = (value: unknown) => formatLabel(textValue(value));
  if (!before) parts.push(`Started · ${status(after.status)}`);
  else if (before.status !== after.status)
    parts.push(`${status(before.status)} → ${status(after.status)}`);
  if (before && before.seats !== after.seats)
    parts.push(`${textValue(before.seats)} → ${count(after.seats, "seat")}`);
  else if (!before) parts.push(count(after.seats, "seat"));
  if (before && before.cancelAtPeriodEnd !== after.cancelAtPeriodEnd)
    parts.push(
      after.cancelAtPeriodEnd
        ? "Cancels at period end"
        : "No longer cancels at period end",
    );
  const periodEnd = textValue(after.periodEnd);
  if (before && before.periodEnd !== after.periodEnd && periodEnd)
    parts.push(`Period ends ${formatDate(periodEnd)}`);
  if (details.reason === "replaced") parts.push("Replaced by a new Checkout");
  return parts.join(" · ") || "Subscription details";
}

function connectionStatus(value: unknown) {
  const connection = state<ConnectionState>(value);
  const status = formatLabel(textValue(connection?.status));
  const code = textValue(connection?.errorCode);
  return code ? `${status} (${code})` : status;
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
  "billing.seats_changed": ({ details }) =>
    `${textValue(details.before)} → ${count(details.after, "seat")} · ${
      details.source === "reconciliation"
        ? "Hourly seat check"
        : "After a membership change"
    }`,
  "billing.subscription_changed": subscriptionSummary,
  "finance.connection_status_changed": ({ details }) =>
    `${connectionStatus(details.before)} → ${connectionStatus(details.after)}`,
  "finance.records_carried_over": ({ details }) =>
    `${count(details.accountCount, "account")} and ${count(details.transactionCount, "transaction")} from ${textValue(details.fromInstitutionName) || "a disconnected bank"}`,
  "finance.transactions_removed": ({ details }) =>
    `${count(details.count, "transaction")} withdrawn by the bank`,
  "finance.connection_data_deleted": ({ details }) =>
    `Deleted ${count(details.accountCount, "account")}, ${count(details.transactionCount, "transaction")}, and ${count(details.annotationCount, "annotation")}`,
};

/** A one-line summary of a bank connection, category, or billing event. */
export function financeActivitySummary(event: ActivityEvent) {
  return summaries[event.action]?.(event);
}
