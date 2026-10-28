import { Banner, Button, Field, Select } from "@balebase/ui/react";
import type { Person } from "@balebase/validators/fields";
import type { IssueInput } from "@balebase/validators/issues";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "./apiClient";
import { errorMessage } from "./errors";
import { useLoad } from "./useLoad";

const emptyIssue: IssueInput = {
  title: "",
  description: "",
  priority: "medium",
  assignedTo: null,
};

export function IssueForm({
  initial = emptyIssue,
  onSave,
  onError,
  label = "Raise issue",
  disabled = false,
  offlineMembers,
  onDirtyChange,
}: {
  initial?: IssueInput;
  onSave: (input: IssueInput) => Promise<void>;
  onError?: (message: string) => void;
  label?: string;
  disabled?: boolean;
  offlineMembers?: Person[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [input, setInput] = useState(initial);
  const { members, memberError } = useIssueMembers(offlineMembers);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  function update(next: IssueInput) {
    setInput(next);
    onDirtyChange?.(
      (Object.keys(next) as (keyof IssueInput)[]).some(
        (key) => next[key] !== initial[key],
      ),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await onSave(input);
    } catch (cause) {
      const message = errorMessage(cause, "Could not save issue.");
      if (onError) onError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      aria-label="Issue details"
      className="stack"
      onSubmit={(event) => void submit(event)}
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {memberError && <Banner>{memberError}</Banner>}
      <fieldset className="issueFields" disabled={disabled || busy}>
        <Field label="Title">
          <input
            className="input"
            required
            maxLength={300}
            value={input.title}
            onChange={(event) =>
              update({ ...input, title: event.target.value })
            }
          />
        </Field>
        <Field label="Description">
          <textarea
            className="textarea"
            maxLength={2000}
            rows={4}
            value={input.description}
            onChange={(event) =>
              update({ ...input, description: event.target.value })
            }
          />
        </Field>
        <div className="formGrid">
          <Field label="Priority">
            <Select
              value={input.priority}
              onChange={(event) =>
                update({
                  ...input,
                  priority: event.target.value as IssueInput["priority"],
                })
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </Select>
          </Field>
          <Field label="Assignee">
            <Select
              disabled={Boolean(memberError)}
              value={input.assignedTo ?? ""}
              onChange={(event) =>
                update({ ...input, assignedTo: event.target.value || null })
              }
            >
              <option value="">Unassigned</option>
              {input.assignedTo &&
                !members.some((member) => member.id === input.assignedTo) && (
                  <option value={input.assignedTo}>Current assignee</option>
                )}
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name || member.email}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <Button
            busy={busy}
            disabled={disabled}
            type="submit"
            variant="primary"
          >
            {label}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function useIssueMembers(offlineMembers: Person[] | undefined) {
  const online = !offlineMembers;
  const { data, error } = useLoad(
    useCallback(
      async () => (online ? (await api.issues.members()).members : []),
      [online],
    ),
    "Could not load assignees.",
  );
  return {
    members: offlineMembers ?? data ?? [],
    memberError:
      error &&
      "Could not load assignees. You can save now and assign this issue later.",
  };
}
