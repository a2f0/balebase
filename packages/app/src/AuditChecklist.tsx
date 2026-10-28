import { Button, Card, cx, Icon, PageSection, Toast } from "@balebase/ui/react";
import type {
  AuditDefinition,
  AuditIssue,
  AuditRun,
  AuditTemplateItem,
  AuditTemplateSection,
} from "@balebase/validators/audits";
import type { Person } from "@balebase/validators/fields";
import { auditLimits } from "@balebase/validators/rules";
import { useReducer } from "react";
import { ApiKeyAttribution } from "./ActivityFeed";
import { AuditIssueDraftFields, useAuditIssueDraft } from "./AuditRunIssues";
import { auditItems, isAnswered } from "./auditProgress";
import { countLabel, formatDateTime, formatLabel } from "./labels";

const checkResponses = ["pass", "fail", "na"] as const;

const choiceTone: Record<
  (typeof checkResponses)[number],
  "danger" | "success" | undefined
> = {
  fail: "danger",
  na: undefined,
  pass: "success",
};

/** What a question needs to raise an issue inline when it is marked Fail. */
interface IssueContext {
  audit: AuditRun;
  auditId: string;
  issues: AuditIssue[];
  members: Person[];
  onCreated: () => Promise<void>;
}

export function AuditChecklist({
  definition,
  issueContext,
  onChange,
  responses,
}: {
  definition: AuditDefinition;
  issueContext: IssueContext;
  onChange: (itemId: string, response: string) => void;
  responses: Record<string, string>;
}) {
  const total = auditItems(definition).length;
  return (
    <PageSection
      actions={
        <span className="sectionCount">{countLabel(total, "question")}</span>
      }
      title="Checklist"
    >
      <div className="runSections">
        {definition.sections.map((section, sectionIndex) => (
          <AuditSection
            index={sectionIndex}
            issueContext={issueContext}
            key={section.id}
            onChange={onChange}
            responses={responses}
            section={section}
          />
        ))}
      </div>
    </PageSection>
  );
}

function AuditSection({
  index,
  issueContext,
  onChange,
  responses,
  section,
}: {
  index: number;
  issueContext: IssueContext;
  onChange: (itemId: string, response: string) => void;
  responses: Record<string, string>;
  section: AuditTemplateSection;
}) {
  const answered = section.items.filter((item) =>
    isAnswered(responses[item.id]),
  ).length;
  const empty = section.items.length === 0;
  const done = !empty && answered === section.items.length;
  return (
    <Card
      actions={
        <span
          className={cx(
            "sectionCount runSectionCount",
            done && "runSectionDone",
          )}
        >
          {done && <Icon name="check" size={16} />}
          {empty
            ? "No questions"
            : `${answered}/${section.items.length} answered`}
        </span>
      }
      className="runSection"
      flush
      title={
        <span className="runSectionTitle">
          <span className="runSectionNumber">
            {String(index + 1).padStart(2, "0")}
          </span>
          {section.title}
        </span>
      }
    >
      {empty ? undefined : (
        <ol className="rowList">
          {section.items.map((item, itemIndex) => (
            <AuditQuestion
              index={itemIndex}
              issueContext={issueContext}
              item={item}
              key={item.id}
              onChange={(response) => onChange(item.id, response)}
              response={responses[item.id] ?? ""}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function AuditQuestion({
  index,
  issueContext,
  item,
  onChange,
  response,
}: {
  index: number;
  issueContext: IssueContext;
  item: AuditTemplateItem;
  onChange: (response: string) => void;
  response: string;
}) {
  const promptId = `audit-item-${item.id}`;
  const [issueState, dispatchIssue] = useReducer(failIssueReducer, {
    offer: 0,
    step: "closed",
  });
  return (
    <li
      className={cx(
        "row runQuestion",
        item.responseType !== "check" && "runQuestionWritten",
        response === "fail" && "runQuestionFailed",
      )}
    >
      <div className="runQuestionBody">
        <span className="runQuestionNumber">{index + 1}</span>
        <div className="runQuestionCopy">
          <p className="runQuestionPrompt" id={promptId}>
            {item.prompt}
          </p>
          {item.required && <span className="runRequired">Required</span>}
        </div>
      </div>
      {item.responseType === "check" ? (
        <ResponseChoices
          labelledBy={promptId}
          onChange={(next) => {
            dispatchIssue({ next, previous: response, type: "answered" });
            onChange(next);
          }}
          response={response}
        />
      ) : (
        <textarea
          aria-labelledby={promptId}
          className="textarea runAnswer"
          maxLength={auditLimits.answer}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Enter response"
          rows={3}
          value={response}
        />
      )}
      <AnswerAttribution
        audit={issueContext.audit}
        itemId={item.id}
        response={response}
      />
      {issueState.step !== "closed" && response === "fail" && (
        <FailedItemIssue
          auditId={issueContext.auditId}
          item={item}
          key={issueState.offer}
          members={issueContext.members}
          onCreated={async (offer, warning) => {
            dispatchIssue({ offer, type: "created", warning });
            await issueContext.onCreated();
          }}
          onSkipChange={(skip) => dispatchIssue({ skip, type: "skipToggled" })}
          openIssueCount={
            issueContext.issues.filter(
              (issue) => issue.itemId === item.id && issue.status === "open",
            ).length
          }
          state={issueState}
        />
      )}
    </li>
  );
}

export function AnswerAttribution({
  audit,
  itemId,
  response,
}: {
  audit: AuditRun;
  itemId: string;
  response: string;
}) {
  if ((audit.responses[itemId] ?? "") !== response) {
    return <p className="runAttribution">Unsaved answer</p>;
  }
  const activity = Object.hasOwn(audit.answerActivity, itemId)
    ? audit.answerActivity[itemId]
    : undefined;
  if (activity) {
    return (
      <p className="runAttribution">
        Updated by{" "}
        <span title={activity.actor.email}>
          {activity.actor.name || activity.actor.email}
        </span>
        <ApiKeyAttribution actor={activity.actor} /> ·{" "}
        {formatDateTime(activity.occurredAt)}
      </p>
    );
  }
  return response ? (
    <p className="runAttribution">Answer saved before activity tracking</p>
  ) : null;
}

/**
 * The inline issue beneath a checklist item. `offer` counts fresh Fail clicks
 * so a submission can be matched to the form it came from.
 */
export type FailIssueState =
  | { offer: number; step: "closed" }
  | { offer: number; step: "offered" }
  | { offer: number; step: "skipped" }
  | { offer: number; step: "created"; warning: string | undefined };

type FailIssueEvent =
  | { next: string; previous: string; type: "answered" }
  | { skip: boolean; type: "skipToggled" }
  | { offer: number; type: "created"; warning: string | undefined };

/**
 * Only a fresh Fail click offers the issue, so failures reloaded from a saved
 * draft keep the checklist compact. Any other answer closes it.
 */
export function failIssueReducer(
  state: FailIssueState,
  event: FailIssueEvent,
): FailIssueState {
  switch (event.type) {
    case "answered":
      if (event.next === event.previous) return state;
      return event.next === "fail"
        ? { offer: state.offer + 1, step: "offered" }
        : { offer: state.offer, step: "closed" };
    case "skipToggled":
      if (state.step !== "offered" && state.step !== "skipped") return state;
      return { offer: state.offer, step: event.skip ? "skipped" : "offered" };
    case "created":
      // A submission that outlived its offer must not replace a newer form.
      if (event.offer !== state.offer || state.step === "closed") return state;
      return { offer: state.offer, step: "created", warning: event.warning };
  }
}

/**
 * The issue offered beneath a freshly failed item. The checkbox records a
 * deliberate failure with no follow-up and tucks the form away.
 */
export function FailedItemIssue({
  auditId,
  item,
  members,
  onCreated,
  onSkipChange,
  openIssueCount,
  state,
}: {
  auditId: string;
  item: AuditTemplateItem;
  members: Person[];
  onCreated: (offer: number, warning?: string) => Promise<void>;
  onSkipChange: (skip: boolean) => void;
  openIssueCount: number;
  state: Exclude<FailIssueState, { step: "closed" }>;
}) {
  const draft = useAuditIssueDraft(auditId, item);

  if (state.step === "created") {
    return (
      <p className="runFailIssueCreated" role="status">
        <Icon name="success" size={16} />
        <span>
          Issue created.
          {state.warning ? ` ${state.warning}` : ""}
        </span>
      </p>
    );
  }

  return (
    <section aria-label="Issue for this failure" className="runFailIssue">
      <label className="check">
        <input
          checked={state.step === "skipped"}
          disabled={draft.busy}
          onChange={(event) => onSkipChange(event.target.checked)}
          type="checkbox"
        />
        Fail without creating issue
      </label>
      {state.step === "offered" && (
        <>
          {openIssueCount > 0 && (
            <p className="fieldHint">
              This item already has {countLabel(openIssueCount, "open issue")}.
            </p>
          )}
          {draft.error && <Toast tone="danger">{draft.error}</Toast>}
          <AuditIssueDraftFields draft={draft} members={members} />
          <div className="formActions">
            <Button
              busy={draft.busy}
              className="runIssueSubmit"
              disabled={!draft.input.title.trim()}
              icon="add"
              onClick={() =>
                void draft.submit((warning) => onCreated(state.offer, warning))
              }
              variant="primary"
            >
              {draft.busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function ResponseChoices({
  labelledBy,
  onChange,
  response,
}: {
  labelledBy: string;
  onChange: (response: string) => void;
  response: string;
}) {
  return (
    <fieldset
      aria-labelledby={labelledBy}
      className="segmented segmentedFill runChoices"
    >
      {checkResponses.map((value) => (
        <button
          aria-pressed={response === value}
          data-tone={choiceTone[value]}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {value === "na" ? "N/A" : formatLabel(value)}
        </button>
      ))}
    </fieldset>
  );
}
