import { Button, Card, Field } from "@balebase/ui/react";
import { projectLimits } from "@balebase/validators/rules";
import { type FormEvent, useState } from "react";

/** Creates a project, or edits one when `initial` is given. */
export function ProjectForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: { description: string; name: string };
  onCancel: () => void;
  onSave: (input: { description: string; name: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave({ description: description.trim(), name: name.trim() });
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
            disabled={!name.trim()}
            type="submit"
            variant="primary"
          >
            {initial ? "Save changes" : "Create project"}
          </Button>
        </div>
      }
      onSubmit={(event) => void submit(event)}
      title={initial ? "Edit project" : "New project"}
    >
      <div className="stack">
        <Field label="Name">
          <input
            // biome-ignore lint/a11y/noAutofocus: the button that opened the form is gone.
            autoFocus
            className="input"
            maxLength={projectLimits.name}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            className="textarea"
            maxLength={projectLimits.description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            value={description}
          />
        </Field>
      </div>
    </Card>
  );
}
