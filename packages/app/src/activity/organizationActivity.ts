import type { ActivityEvent } from "@balebase/validators/activity";
import { formatRoles } from "../organizations/organizationState";
import { textValue } from "./activityLabels";

/** Labels for membership, invitation and organization lifecycle events. */
export const organizationActionLabels: Record<string, string> = {
  "organization.deletion_requested": "deleted the organization",
  "organization.invitation_accepted": "accepted an invitation",
  "organization.invitation_canceled": "canceled an invitation",
  "organization.invitation_created": "sent an invitation",
  "organization.invitation_rejected": "declined an invitation",
  "organization.member_joined": "joined the organization",
  "organization.member_left": "left the organization",
  "organization.member_removed": "removed a member",
  "organization.restored": "restored the organization",
  "organization.updated": "changed the organization",
};

const fieldLabels: Record<string, string> = {
  logo: "Logo",
  name: "Name",
  slug: "URL name",
};

/** Why a group or equipment change happened, when a membership ended. */
export function removalReasonLabel(reason: unknown) {
  if (reason === "member_left") return "Left the organization";
  if (reason === "member_removed") return "Removed from the organization";
  return undefined;
}

/** One line for an organization or invitation event. */
export function organizationActivitySummary({
  action,
  details,
}: ActivityEvent) {
  switch (action) {
    case "organization.updated":
      return changes(details.changes).join(" · ") || "No changes";
    case "organization.deletion_requested":
      return `${viaLabel(details.via)} · Pending invitations canceled: ${textValue(details.canceledInvitations) || "0"}`;
    case "organization.restored":
      return `${viaLabel(details.via)} · Deleted by ${textValue(details.deletedByName) || textValue(details.deletedByEmail) || "someone no longer recorded"}`;
    default:
      return [
        textValue(details.email),
        details.role ? formatRoles(textValue(details.role)) : "",
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/** One line for someone joining, leaving, or being removed. */
export function membershipSummary(event: ActivityEvent) {
  const { details } = event;
  const person =
    textValue(details.userName) ||
    textValue(details.userEmail) ||
    event.root.label;
  const role = formatRoles(textValue(details.role));
  if (event.action === "organization.member_joined") {
    const inviter =
      textValue(details.inviterName) || textValue(details.inviterEmail);
    return `${person} · ${role}${inviter ? ` · Invited by ${inviter}` : ""}`;
  }
  const keys = Array.isArray(details.apiKeys) ? details.apiKeys : [];
  const keyNames = keys
    .map((key: unknown) => textValue(Reflect.get(Object(key), "name")))
    .filter(Boolean);
  return [
    person,
    role,
    ...(keyNames.length ? [`API keys stopped: ${keyNames.join(", ")}`] : []),
  ].join(" · ");
}

function viaLabel(via: unknown) {
  return via === "root_admin" ? "By a root admin" : "By an owner";
}

function changes(value: unknown) {
  return (Array.isArray(value) ? value : []).map((change: unknown) => {
    const field = textValue(Reflect.get(Object(change), "field"));
    const before = textValue(Reflect.get(Object(change), "before")) || "None";
    const after = textValue(Reflect.get(Object(change), "after")) || "None";
    return `${fieldLabels[field] ?? field}: ${before} → ${after}`;
  });
}
