import { Banner, Button, Field, Select } from "@balebase/ui/react";
import type { Person } from "@balebase/validators/fields";
import { issueLimits, issuePriorities } from "@balebase/validators/issueRules";
import type { IssueInput } from "@balebase/validators/issues";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { formatLabel } from "../shared/labels";
import { useLoad } from "../shared/useLoad";

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
        <IssueFields
          input={input}
          members={members}
          membersUnavailable={Boolean(memberError)}
          onChange={update}
        />
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

/** The fields every issue form shares, including the audit run's. */
export function IssueFields({
  input,
  members,
  membersUnavailable = false,
  onChange,
}: {
  input: IssueInput;
  members: Person[];
  membersUnavailable?: boolean;
  onChange: (input: IssueInput) => void;
}) {
  return (
    <>
      <Field label="Title">
        <input
          className="input"
          maxLength={issueLimits.title}
          onChange={(event) =>
            onChange({ ...input, title: event.target.value })
          }
          required
          value={input.title}
        />
      </Field>
      <Field label="Description" optional>
        <textarea
          className="textarea"
          maxLength={issueLimits.description}
          onChange={(event) =>
            onChange({ ...input, description: event.target.value })
          }
          placeholder="Describe the problem, evidence, and expected follow-up."
          rows={4}
          value={input.description}
        />
      </Field>
      <div className="formRow">
        <Field label="Priority">
          <Select
            onChange={(event) =>
              onChange({
                ...input,
                priority: event.target.value as IssueInput["priority"],
              })
            }
            value={input.priority}
          >
            {issuePriorities.map((priority) => (
              <option key={priority} value={priority}>
                {formatLabel(priority)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assignee">
          <Select
            disabled={membersUnavailable}
            onChange={(event) =>
              onChange({ ...input, assignedTo: event.target.value || null })
            }
            value={input.assignedTo ?? ""}
          >
            <option value="">Unassigned</option>
            {input.assignedTo &&
              !members.some((member) => member.id === input.assignedTo) && (
                <option value={input.assignedTo}>Current assignee</option>
              )}
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name
                  ? `${member.name} · ${member.email}`
                  : member.email}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
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
