import { Button, Card, Field, Select } from "@balebase/ui/react";
import type {
  EquipmentInput,
  EquipmentItem,
  EquipmentMember,
} from "@balebase/validators/equipment";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { AssigneeSelect } from "./EquipmentAssignee";
import { equipmentTypeLabel } from "./equipmentLabels";

export function EquipmentForm({
  initial,
  members,
  onCancel,
  onSave,
  types,
}: {
  initial?: EquipmentItem;
  members: EquipmentMember[];
  onCancel: () => void;
  onSave: (input: EquipmentInput) => Promise<boolean>;
  types: string[];
}) {
  const [form, setForm] = useState<EquipmentInput>({
    assigneeId: initial?.assignee?.id ?? null,
    make: initial?.make ?? "",
    model: initial?.model ?? "",
    purchaseDate: initial?.purchaseDate ?? null,
    serialNumber: initial?.serialNumber ?? null,
    type: initial?.type ?? types[0] ?? "",
  });
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLSelectElement>(null);
  // The button that opened the form is gone; move focus into the form.
  useEffect(() => firstField.current?.focus(), []);
  const set = <Key extends keyof EquipmentInput>(
    key: Key,
    value: EquipmentInput[Key],
  ) => setForm((current) => ({ ...current, [key]: value }));
  // Keep a type the list no longer offers selectable while editing.
  const typeOptions =
    initial && !types.includes(initial.type) ? [...types, initial.type] : types;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave({
      ...form,
      make: form.make.trim(),
      model: form.model.trim(),
      serialNumber: form.serialNumber?.trim() || null,
    });
    setSaving(false);
  }

  return (
    <Card
      footer={
        <div className="cluster">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button
            busy={saving}
            disabled={!form.make.trim() || !form.model.trim() || !form.type}
            icon={initial ? undefined : "add"}
            type="submit"
            variant="primary"
          >
            {initial ? "Save changes" : "Add equipment"}
          </Button>
        </div>
      }
      onSubmit={(event) => void submit(event)}
      title={initial ? "Edit equipment" : "Add equipment"}
    >
      <EquipmentFields
        firstField={firstField}
        form={form}
        members={members}
        set={set}
        typeOptions={typeOptions}
      />
    </Card>
  );
}

function EquipmentFields({
  firstField,
  form,
  members,
  set,
  typeOptions,
}: {
  firstField: RefObject<HTMLSelectElement | null>;
  form: EquipmentInput;
  members: EquipmentMember[];
  set: <Key extends keyof EquipmentInput>(
    key: Key,
    value: EquipmentInput[Key],
  ) => void;
  typeOptions: string[];
}) {
  return (
    <div className="equipmentFields">
      <Field label="Type">
        <Select
          ref={firstField}
          onChange={(event) => set("type", event.target.value)}
          required
          value={form.type}
        >
          {typeOptions.map((type) => (
            <option key={type} value={type}>
              {equipmentTypeLabel(type)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Assigned to" optional>
        <AssigneeSelect
          compact={false}
          label="Assigned to"
          members={members}
          onChange={(assigneeId) => set("assigneeId", assigneeId)}
          value={form.assigneeId}
        />
      </Field>
      <Field label="Make">
        <input
          className="input"
          maxLength={80}
          onChange={(event) => set("make", event.target.value)}
          placeholder="Apple"
          required
          value={form.make}
        />
      </Field>
      <Field label="Model">
        <input
          className="input"
          maxLength={120}
          onChange={(event) => set("model", event.target.value)}
          placeholder="MacBook Pro 14-inch"
          required
          value={form.model}
        />
      </Field>
      <Field label="Serial number" optional>
        <input
          autoCapitalize="characters"
          className="input mono"
          maxLength={100}
          onChange={(event) => set("serialNumber", event.target.value)}
          spellCheck={false}
          value={form.serialNumber ?? ""}
        />
      </Field>
      <Field label="Purchase date" optional>
        <input
          className="input"
          onChange={(event) => set("purchaseDate", event.target.value || null)}
          type="date"
          value={form.purchaseDate ?? ""}
        />
      </Field>
    </div>
  );
}
