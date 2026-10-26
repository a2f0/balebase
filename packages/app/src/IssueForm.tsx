import { Banner, Button, Field, Select } from "@balebase/ui/react";
import type { IssueInput, IssueMember } from "@balebase/validators/issues";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "./apiClient";

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
  offlineMembers?: IssueMember[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [input, setInput] = useState(initial);
  const { members, memberError } = useIssueMembers(offlineMembers);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onDirtyChange?.(JSON.stringify(input) !== JSON.stringify(initial));
  }, [initial, input, onDirtyChange]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await onSave(input);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not save issue.";
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
              setInput({ ...input, title: event.target.value })
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
              setInput({ ...input, description: event.target.value })
            }
          />
        </Field>
        <div className="formGrid">
          <Field label="Priority">
            <Select
              value={input.priority}
              onChange={(event) =>
                setInput({
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
                setInput({ ...input, assignedTo: event.target.value || null })
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

function useIssueMembers(offlineMembers: IssueMember[] | undefined) {
  const [members, setMembers] = useState<IssueMember[]>([]);
  const [memberError, setMemberError] = useState<string>();
  useEffect(() => {
    if (offlineMembers) {
      setMembers(offlineMembers);
      return;
    }
    let active = true;
    void api.issues
      .members()
      .then((data) => {
        if (active) setMembers(data.members);
      })
      .catch(() => {
        if (active)
          setMemberError(
            "Could not load assignees. You can save now and assign this issue later.",
          );
      });
    return () => {
      active = false;
    };
  }, [offlineMembers]);
  return { members, memberError };
}
