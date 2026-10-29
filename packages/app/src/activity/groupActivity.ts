import type { ActivityEvent } from "@balebase/validators/activity";
import { textValue } from "./activityLabels";

const capabilityLabels: Record<string, string> = { finance: "Finance" };

function people(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(
      (person: unknown) =>
        textValue(Reflect.get(Object(person), "name")) ||
        textValue(Reflect.get(Object(person), "email")),
    )
    .filter(Boolean);
}

function capabilities(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(textValue)
    .filter(Boolean)
    .map((capability) => capabilityLabels[capability] ?? capability);
}

function listed(label: string, values: string[]) {
  return values.length ? [`${label}: ${values.join(", ")}`] : [];
}

/** What a group event granted, revoked, or held, on one line. */
export function groupActivitySummary({ action, details }: ActivityEvent) {
  if (action === "organization.group_updated") {
    const parts = [
      ...(details.renamedFrom
        ? [`Renamed from ${textValue(details.renamedFrom)}`]
        : []),
      ...listed("Added", people(details.addedMembers)),
      ...listed("Removed", people(details.removedMembers)),
      ...listed("Access granted", capabilities(details.addedCapabilities)),
      ...listed("Access removed", capabilities(details.removedCapabilities)),
    ];
    return parts.join(" · ") || "No changes";
  }
  const members = people(details.members);
  const access = capabilities(details.capabilities);
  return [
    members.length ? `Members: ${members.join(", ")}` : "No members",
    access.length ? `Access: ${access.join(", ")}` : "No access",
  ].join(" · ");
}
