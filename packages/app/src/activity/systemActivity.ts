import { productName } from "@balebase/ui/brand";
import {
  type ActivityActor,
  type ActivityEvent,
  activityProviderNames,
} from "@balebase/validators/activity";
import { formatDate } from "../shared/labels";
import { textValue } from "./activityLabels";

/** Who made a change: a person, Balebase's maintenance, or a provider. */
export function actorName(actor: ActivityActor) {
  if (actor.type === "system") return `${productName} maintenance`;
  if (actor.type === "provider")
    return Reflect.get(activityProviderNames, actor.source ?? "") ?? actor.name;
  return actor.name || actor.email;
}

/** The line under an actor: a person's email, or what kind of change it was. */
export function actorDetail(actor: ActivityActor) {
  if (actor.type === "system") return "Automatic maintenance";
  if (actor.type === "provider") return "Provider update";
  return actor.email;
}

export const systemActionLabels: Record<string, string> = {
  "inbox.email_purged": "permanently deleted an email from Trash",
  "organization.audit_runs_purged": "removed audits past Free-plan retention",
  "organization.purged": "permanently deleted an organization",
  "user.purged": "permanently deleted an account",
};

/** Which account or organization was purged, and who asked for it. */
export function purgeSummary(event: ActivityEvent) {
  const kind = event.action === "user.purged" ? "Account" : "Organization";
  return `${kind} ${event.root.id} · ${purgeRequester(event)}`;
}

function purgeRequester({ action, details }: ActivityEvent) {
  const person =
    action === "user.purged"
      ? textValue(details.requestedByName) ||
        textValue(details.requestedByEmail)
      : textValue(details.deletedByName) || textValue(details.deletedByEmail);
  const requestedAt = textValue(
    action === "user.purged" ? details.requestedAt : details.deletedAt,
  );
  const when = requestedAt ? ` on ${formatDate(requestedAt)}` : "";
  switch (details.via) {
    case "self":
      return `Requested by the account holder${when}`;
    case "root_admin":
      return `Requested by ${person || "a root admin"} (root admin)${when}`;
    case "owner":
      return `Deleted by ${person || "an owner"} (owner)${when}`;
    default:
      return `Requester not recorded${when}`;
  }
}

/** How many audits Free-plan retention removed. */
export function retentionSummary({ details }: ActivityEvent) {
  const count = typeof details.count === "number" ? details.count : 0;
  const before = textValue(details.completedBefore);
  return `${count} completed audit${count === 1 ? "" : "s"}${before ? ` from before ${formatDate(before)}` : ""} removed`;
}

/** What a trashed email's purge removed with it. */
export function emailPurgeSummary({ details }: ActivityEvent) {
  const count = (value: unknown, noun: string) => {
    const amount = typeof value === "number" ? value : 0;
    return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
  };
  return [
    count(details.attachmentCount, "attachment"),
    count(details.folderLinkCount, "folder link"),
    count(details.equipmentLinkCount, "equipment link"),
  ].join(" · ");
}

/** Why maintenance removed a link or a project's form. */
export function systemReasonLabel(reason: unknown) {
  if (reason === "email_purged") return "The email was purged from Trash";
  if (reason === "form_purged") return "The discarded global form was purged";
  return undefined;
}
