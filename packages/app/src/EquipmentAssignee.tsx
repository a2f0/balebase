import { Avatar, Select } from "@balebase/ui/react";
import type { EquipmentMember } from "@balebase/validators/equipment";

export function Assignee({ member }: { member: EquipmentMember | null }) {
  if (!member) {
    return (
      <span className="equipmentAssignee equipmentUnassigned">Unassigned</span>
    );
  }
  return (
    <span className="equipmentAssignee">
      <Avatar name={member.name} size="sm" />
      <span className="truncate">{member.name}</span>
    </span>
  );
}

export function AssigneeSelect({
  compact = true,
  disabled,
  label,
  members,
  onChange,
  value,
}: {
  /** Inline on the details card; full size in the form. */
  compact?: boolean;
  disabled?: boolean;
  label: string;
  members: EquipmentMember[];
  onChange: (assigneeId: string | null) => void;
  value: string | null;
}) {
  return (
    <Select
      aria-label={label}
      className={compact ? "inputSm equipmentAssigneeSelect" : undefined}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Unassigned</option>
      {members.map((member) => (
        <option key={member.id} value={member.id}>
          {member.name} ({member.email})
        </option>
      ))}
    </Select>
  );
}
