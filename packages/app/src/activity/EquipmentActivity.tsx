import type { ActivityEvent } from "@balebase/validators/activity";
import { equipmentTypeLabel } from "../equipment/equipmentLabels";
import { formatCalendarDate } from "../shared/labels";
import { assigneeLabel, textValue } from "./activityLabels";
import { removalReasonLabel } from "./organizationActivity";

interface EquipmentChange {
  after: unknown;
  before: unknown;
  field: string;
}

const fieldLabels: Record<string, string> = {
  make: "Make",
  model: "Model",
  purchaseDate: "Purchase date",
  serialNumber: "Serial number",
  type: "Type",
};

/** The one-line summary a compact activity row shows before expanding. */
export function equipmentActivitySummary(event: ActivityEvent) {
  const { details } = event;
  if (event.action === "equipment.assigned") return assigneeChange(event);
  if (event.action === "equipment.updated") {
    return equipmentChanges(details.changes).map(changeLabel).join(" · ");
  }
  return [equipmentTypeLabel(textValue(details.type)), details.serialNumber]
    .filter(Boolean)
    .join(" · ");
}

export function EquipmentActivityDetails({ event }: { event: ActivityEvent }) {
  const { details } = event;
  if (event.action === "equipment.assigned") {
    return <p className="activityDetails">{assigneeChange(event)}</p>;
  }
  if (event.action === "equipment.updated") {
    return (
      <div className="activityDetails">
        {equipmentChanges(details.changes).map((change) => (
          <p key={change.field}>{changeLabel(change)}</p>
        ))}
      </div>
    );
  }
  // Added and deleted equipment carry a snapshot of the item.
  return (
    <div className="activityDetails">
      <p>
        {equipmentTypeLabel(textValue(details.type))} ·{" "}
        {textValue(details.make)} {textValue(details.model)}
      </p>
      <p>
        Serial number: {fieldValue("serialNumber", details.serialNumber)} ·
        Purchase date: {fieldValue("purchaseDate", details.purchaseDate)}
      </p>
      {/* Deletions recorded before they kept the holder say nothing. */}
      {(event.action === "equipment.created" || "assignedTo" in details) && (
        <p>
          Assigned to:{" "}
          {assigneeLabel(
            details.assignedTo,
            details.assigneeName,
            details.assigneeEmail,
          )}
        </p>
      )}
      {typeof details.emailLinkCount === "number" && (
        <p>Email links removed: {details.emailLinkCount}</p>
      )}
    </div>
  );
}

function assigneeChange({ details }: ActivityEvent) {
  const reason = removalReasonLabel(details.reason);
  return `${assigneeLabel(details.before, details.beforeName, details.beforeEmail)} → ${assigneeLabel(details.after, details.afterName, details.afterEmail)}${reason ? ` · ${reason}` : ""}`;
}

function changeLabel({ after, before, field }: EquipmentChange) {
  return `${fieldLabels[field] ?? field}: ${fieldValue(field, before)} → ${fieldValue(field, after)}`;
}

function fieldValue(field: string, value: unknown) {
  const text = textValue(value);
  if (!text) return "Not recorded";
  if (field === "type") return equipmentTypeLabel(text);
  return field === "purchaseDate" ? formatCalendarDate(text) : text;
}

function equipmentChanges(value: unknown) {
  return Array.isArray(value) ? value.filter(isEquipmentChange) : [];
}

function isEquipmentChange(value: unknown): value is EquipmentChange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "field") === "string"
  );
}
