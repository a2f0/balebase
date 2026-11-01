import type { ActivityEvent } from "@balebase/validators/activity";
import { textValue } from "./activityLabels";
import { systemReasonLabel } from "./systemActivity";

const fieldLabels: Record<string, string> = {
  description: "Description",
  name: "Name",
};

/** What a project event changed, on one line. */
export function projectActivitySummary({
  action,
  details,
  root,
}: ActivityEvent) {
  switch (action) {
    case "project.member_added":
    case "project.member_removed":
      return textValue(details.userName) || textValue(details.userEmail);
    case "project.form_enabled":
    case "project.form_disabled":
      return [textValue(details.title), systemReasonLabel(details.reason)]
        .filter(Boolean)
        .join(" · ");
    case "project.updated":
      return (Array.isArray(details.changes) ? details.changes : [])
        .map((change: unknown) => {
          const field = textValue(Reflect.get(Object(change), "field"));
          const before = textValue(Reflect.get(Object(change), "before"));
          const after = textValue(Reflect.get(Object(change), "after"));
          return `${fieldLabels[field] ?? field}: ${before || "None"} → ${after || "None"}`;
        })
        .join(" · ");
    default:
      return root.label;
  }
}
