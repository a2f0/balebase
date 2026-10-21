import type { ActivityEvent } from "./activityApi";

/** Only changed fields are shown; empty notes/labels explicitly show removals. */
export function RecordActivityDetails({ event }: { event: ActivityEvent }) {
  const before = record(event.details.before);
  const after = record(event.details.after);
  const fields =
    event.action === "finance.transaction_annotated"
      ? ["note", "labels", "reviewed"]
      : ["title", "description", "priority"];
  return (
    <div className="activityDetails">
      {fields
        .filter(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        )
        .map((key) => (
          <p key={key} className="activityChange">
            <strong>{key.charAt(0).toUpperCase() + key.slice(1)}: </strong>
            <span>{value(before[key])}</span>
            <span aria-hidden="true"> → </span>
            <span className="srOnly"> changed to </span>
            <span>{value(after[key])}</span>
          </p>
        ))}
    </div>
  );
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function value(input: unknown): string {
  if (typeof input === "boolean") return input ? "Reviewed" : "Not reviewed";
  if (Array.isArray(input)) return input.join(", ") || "None";
  return typeof input === "string" && input ? input : "None";
}
