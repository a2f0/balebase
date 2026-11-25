import {
  Banner,
  Button,
  Card,
  Field,
  PageSection,
  Select,
} from "@balebase/ui/react";
import { formLimits } from "@balebase/validators/rules";
import { useState } from "react";
import { guardWorkspaceChange } from "../workspace/navigationGuard";
import { formRunPath } from "../workspace/workspacePaths";
import { OfflineIssueCreator, OfflineIssueList } from "./OfflineIssues";
import {
  type FormWriteJob,
  formWrites,
  own,
  unsyncedAnswers,
} from "./offlineFormState";
import type {
  AnswerWrite,
  OfflineForm,
  OfflineWorkspace,
} from "./offlineStore";
import { useOfflineAnswers } from "./useOfflineAnswers";

const checkLabels: Record<string, string> = {
  fail: "Fail",
  na: "N/A",
  pass: "Pass",
};

/**
 * Answers a form on this device, saving each answer here as it is given.
 * Saving a draft's progress shares it with the server as an in-progress
 * form; from then on its answers sync both ways while the device is online,
 * the later answer winning where two people answered the same item.
 * Completing it queues its completion; issues raised on its items sync onto
 * the server's form.
 */
export function OfflineFormEditor({
  form,
  workspace,
  onNavigate,
}: {
  form: OfflineForm;
  workspace: OfflineWorkspace;
  onNavigate: (path: string) => void;
}) {
  const [issueItem, setIssueItem] = useState<string>();
  const { responses, pending, sealing, error, answer, save } =
    useOfflineAnswers(form, workspace.key);
  const writes = formWrites(workspace.jobs, form.id);
  const completed = form.status === "completed";
  return (
    <PageSection title={`Questions · v${form.template.version}`}>
      {error && (
        <Banner
          tone="danger"
          actions={
            <Button disabled={pending > 0} onClick={() => void save()}>
              Retry saving draft
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      <p role="status">
        {pending
          ? "Saving on this device…"
          : error
            ? "Some changes have not been saved."
            : syncStatus(form, writes)}
      </p>
      {form.template.definition.sections.map((section) => (
        <Card key={section.id} title={section.title}>
          {section.items.map((item) => (
            <div key={item.id} className="stack">
              <Field
                label={`${item.prompt}${item.required ? " (required)" : ""}`}
              >
                <AnswerInput
                  disabled={completed || sealing}
                  onAnswer={(value) => void answer(item.id, value)}
                  responseType={item.responseType}
                  value={own(responses, item.id) ?? ""}
                />
              </Field>
              <ReplacedAnswer
                answer={own(form.replaced, item.id)}
                responseType={item.responseType}
              />
              <Button
                onClick={() =>
                  void guardWorkspaceChange(async () =>
                    setIssueItem(issueItem === item.id ? undefined : item.id),
                  )()
                }
              >
                Raise issue
              </Button>
              {issueItem === item.id && (
                <OfflineIssueCreator
                  workspace={workspace}
                  target={{ formId: form.id, itemId: item.id }}
                  onSaved={() => setIssueItem(undefined)}
                />
              )}
            </div>
          ))}
        </Card>
      ))}
      <div className="cluster">
        {!completed && (
          <>
            {form.status === "draft" && (
              <Button
                disabled={pending > 0}
                onClick={() => void save("progress")}
              >
                Save progress
              </Button>
            )}
            <Button
              busy={pending > 0}
              disabled={pending > 0}
              variant="primary"
              onClick={() => void save("completion")}
            >
              Complete form
            </Button>
          </>
        )}
        {writes[0]?.status === "synced" && (
          <Button
            variant="ghost"
            onClick={() => onNavigate(formRunPath(form.id))}
          >
            Open synced form
          </Button>
        )}
      </div>
      <OfflineIssueList
        workspace={workspace}
        formId={form.id}
        onNavigate={onNavigate}
      />
    </PageSection>
  );
}

/** A text answer, or a pass, fail, or N/A choice. */
function AnswerInput({
  disabled,
  onAnswer,
  responseType,
  value,
}: {
  disabled: boolean;
  onAnswer: (value: string) => void;
  responseType: string;
  value: string;
}) {
  return responseType === "text" ? (
    <textarea
      className="textarea"
      maxLength={formLimits.answer}
      disabled={disabled}
      value={value}
      onChange={(event) => onAnswer(event.target.value)}
    />
  ) : (
    <Select
      disabled={disabled}
      value={value}
      onChange={(event) => onAnswer(event.target.value)}
    >
      <option value="" disabled>
        Choose an answer
      </option>
      <option value="pass">Pass</option>
      <option value="fail">Fail</option>
      <option value="na">N/A</option>
    </Select>
  );
}

/** This device's answer the server did not keep, if any. */
function ReplacedAnswer({
  answer,
  responseType,
}: {
  answer: AnswerWrite | undefined;
  responseType: string;
}) {
  if (!answer) return null;
  const label =
    responseType === "check"
      ? (checkLabels[answer.value] ?? answer.value)
      : answer.value;
  return (
    <p className="textSm">
      Your answer “{label}” was not kept; the server kept the answer given
      elsewhere. Both are in the form's history.
    </p>
  );
}

/** Where the form's answers stand against the server's copy. */
function syncStatus(form: OfflineForm, writes: FormWriteJob[]) {
  const blocked = writes.find((job) => job.status === "blocked");
  const synced =
    !unsyncedAnswers(form) && writes.every((job) => job.status === "synced");
  switch (form.status) {
    case "draft":
      return "Draft saved on this device. Save progress to share it; its answers then sync both ways while this device is online.";
    case "inProgress":
      if (blocked) return `Not synced. ${blocked.error ?? ""}`.trim();
      return synced
        ? "Synced with the server."
        : "Saved on this device. Answers sync both ways while this device is online.";
    case "completed":
      return synced
        ? "Completed and synced. Open the synced form to make further changes."
        : "Completed. It syncs when this device is online; open the synced form to make further changes.";
  }
}
