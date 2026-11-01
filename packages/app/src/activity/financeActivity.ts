import type { ActivityEvent } from "@balebase/validators/activity";
import { countLabel } from "../shared/labels";
import { textValue } from "./activityLabels";

/** Labels for the bank connection, expense category, and billing events. */
export const financeActionLabels: Record<string, string> = {
  "billing.checkout_started": "started Pro checkout",
  "billing.portal_opened": "opened the Stripe billing portal",
  "billing.subscription_canceled": "canceled the Pro subscription",
  "finance.categories_defaults_added": "added the common expense categories",
  "finance.category_created": "created an expense category",
  "finance.category_deleted": "deleted an expense category",
  "finance.category_renamed": "renamed an expense category",
  "finance.connection_created": "connected a bank",
  "finance.connection_data_deleted": "deleted a bank's imported data",
  "finance.connection_repaired": "reported a bank login repair",
};

function count(value: unknown, singular: string) {
  return countLabel(typeof value === "number" ? value : 0, singular);
}

const summaries: Partial<Record<string, (event: ActivityEvent) => string>> = {
  "billing.checkout_started": ({ details }) =>
    `Pro for ${count(details.quantity, "seat")}`,
  // Changes made in the portal arrive from Stripe and are not recorded yet.
  "billing.portal_opened": () => "Stripe Billing Portal session",
  "billing.subscription_canceled": ({ details }) =>
    [
      details.reason === "organization_deletion"
        ? "For organization deletion"
        : "Canceled",
      details.via === "root_admin" ? "By a root admin" : "By an owner",
      count(details.seatQuantity, "seat"),
      details.previousStatus ? `Was ${textValue(details.previousStatus)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
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
  "finance.connection_data_deleted": ({ details }) => {
    const removed = [
      count(details.accountCount, "account"),
      count(details.transactionCount, "transaction"),
      count(details.annotationCount, "annotation"),
      // Deletions recorded before these were counted have no such field.
      ...(typeof details.issueCount === "number"
        ? [count(details.issueCount, "issue")]
        : []),
      ...(typeof details.emailLinkCount === "number"
        ? [count(details.emailLinkCount, "email link")]
        : []),
    ];
    return `Deleted ${removed.slice(0, -1).join(", ")}, and ${removed.at(-1)}`;
  },
  "finance.connection_repaired": ({ details, root }) =>
    [
      textValue(details.institutionName) || root.label,
      details.errorCodeBefore
        ? `Was ${textValue(details.errorCodeBefore)}`
        : `Was ${textValue(details.statusBefore) || "unknown"}`,
    ].join(" · "),
};

/** A one-line summary of a bank connection, category, or billing event. */
export function financeActivitySummary(event: ActivityEvent) {
  return summaries[event.action]?.(event);
}
