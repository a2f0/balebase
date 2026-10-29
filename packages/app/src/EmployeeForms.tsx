import {
  Badge,
  Button,
  Card,
  Field,
  LoadingState,
  Select,
  Toast,
} from "@balebase/ui/react";
import type {
  EmployeeRequirement,
  EmployeeRequirementKind,
  EmployeeRequirementStatus,
} from "@balebase/validators/employeeForms";
import {
  employeeRequirementLimits,
  isUsStateCode,
} from "@balebase/validators/rules";
import { type FormEvent, useCallback, useState } from "react";
import {
  downloadEmployeeForm,
  downloadScreeningConsent,
} from "./employeeFormDownloads";
import {
  canCompleteRequirement,
  type RequirementDraft,
  reviewRevisionForStatus,
} from "./employeeOnboarding";
import { isClosedReportStatus, requirementBadge } from "./requirementStatus";
import { api } from "./shared/apiClient";
import { formatCalendarDate, formatDate } from "./shared/labels";
import { useAction } from "./shared/useAction";
import { useLoad } from "./shared/useLoad";

const options: Array<{ kind: EmployeeRequirementKind; title: string }> = [
  { kind: "form", title: "W-4" },
  { kind: "form", title: "W-9" },
  { kind: "form", title: "I-9" },
  { kind: "form", title: "W-2" },
  { kind: "form", title: "1099" },
  { kind: "form", title: "Other form" },
  { kind: "background_check", title: "Background check" },
  { kind: "credit_check", title: "Credit check" },
];

export function RequirementDraftEditor({
  drafts,
  disabled,
  onChange,
}: {
  drafts: RequirementDraft[];
  disabled: boolean;
  onChange: (drafts: RequirementDraft[]) => void;
}) {
  const [optionIndex, setOptionIndex] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const selected = options[optionIndex] ?? { kind: "form", title: "W-4" };
  function add() {
    const title =
      selected.title === "Other form" ? customTitle.trim() : selected.title;
    if (
      !title ||
      !dueDate ||
      drafts.length >= employeeRequirementLimits.requirements
    )
      return;
    onChange([
      ...drafts,
      { id: crypto.randomUUID(), kind: selected.kind, title, dueDate },
    ]);
    setCustomTitle("");
  }
  return (
    <div className="requirementEditor">
      <div className="requirementEditorFields">
        <Field label="Requirement">
          <Select
            disabled={disabled}
            onChange={(event) => setOptionIndex(Number(event.target.value))}
            value={optionIndex}
          >
            {options.map((option, index) => (
              <option key={`${option.kind}-${option.title}`} value={index}>
                {option.title}
              </option>
            ))}
          </Select>
        </Field>
        {selected.title === "Other form" && (
          <Field label="Form name">
            <input
              className="input"
              disabled={disabled}
              maxLength={employeeRequirementLimits.title}
              onChange={(event) => setCustomTitle(event.target.value)}
              value={customTitle}
            />
          </Field>
        )}
        <Field label="Due date">
          <input
            className="input"
            disabled={disabled}
            onChange={(event) => setDueDate(event.target.value)}
            type="date"
            value={dueDate}
          />
        </Field>
        <Button
          disabled={
            disabled ||
            !dueDate ||
            (selected.title === "Other form" && !customTitle.trim()) ||
            drafts.length >= employeeRequirementLimits.requirements
          }
          onClick={add}
          size="sm"
          type="button"
        >
          Add
        </Button>
      </div>
      {drafts.length > 0 && (
        <ul className="requirementDrafts">
          {drafts.map((draft, index) => (
            <li key={draft.id}>
              <span>
                {draft.title} · Due {formatCalendarDate(draft.dueDate)}
              </span>
              <Button
                aria-label={`Remove ${draft.title}`}
                disabled={disabled}
                onClick={() => onChange(drafts.filter((_, at) => at !== index))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Requests either belong to one current member, or have no member page: they
 * target a pending invitation, or a member who has since left.
 */
export type RequirementScope =
  | { kind: "member"; memberId: string }
  | { kind: "unattached"; memberIds: string[] };

export function inRequirementScope(
  scope: RequirementScope,
  requirement: EmployeeRequirement,
) {
  if (scope.kind === "member") return requirement.memberId === scope.memberId;
  return (
    !requirement.memberId || !scope.memberIds.includes(requirement.memberId)
  );
}

/**
 * A manager's view of requested forms and checks in one scope. On a member's
 * page, managers also request new ones; requests without a member page keep
 * every other control. People complete their own in My documents.
 */
export function EmployeeForms({ scope }: { scope: RequirementScope }) {
  // The list covers every scope, so a new scope only filters it again.
  const loaded = useLoad(
    useCallback(async () => (await api.employeeForms.list()).requirements, []),
    "Could not load requirements.",
  );
  const requirements = loaded.data?.filter((item) =>
    inRequirementScope(scope, item),
  );
  const loading = loaded.loading;
  const change = useAction("Could not update requirements.");
  const { busy, notice } = change;
  const error = change.error ?? loaded.error;
  const load = loaded.reload;

  async function action<T>(
    work: () => Promise<T>,
    success: string | ((result: T) => string),
  ) {
    // Reload either way so a refused change shows what is stored, and stay
    // busy until it has, so no action runs against stale requirements.
    await change.run(async () => {
      try {
        return await work();
      } catch (cause) {
        // Until the reload succeeds, nothing stale stays actionable.
        loaded.setData(undefined);
        throw cause;
      } finally {
        await load();
      }
    }, success);
  }

  return (
    <Card
      description={scopeDescription(scope)}
      title={
        scope.kind === "member"
          ? "Forms and checks"
          : "Invitees and former members"
      }
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {scope.kind === "member" && (
        <RequirementAssignmentForm
          action={action}
          busy={busy}
          memberId={scope.memberId}
        />
      )}
      {!requirements && loading ? (
        <LoadingState label="Loading requirements…" />
      ) : !requirements ? (
        <Button onClick={() => void load()} size="sm" type="button">
          Retry loading requirements
        </Button>
      ) : requirements.length === 0 ? (
        <p className="muted">No forms or checks have been requested.</p>
      ) : (
        <ul className="requirementList">
          {requirements.map((requirement) => (
            <RequirementItem
              action={action}
              busy={busy}
              key={requirement.id}
              requirement={requirement}
              showTarget={scope.kind === "unattached"}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RequirementAssignmentForm({
  action,
  busy,
  memberId,
}: {
  action: RequirementAction;
  busy: boolean;
  memberId: string;
}) {
  const [drafts, setDrafts] = useState<RequirementDraft[]>([]);
  function assign(event: FormEvent) {
    event.preventDefault();
    if (!drafts.length) return;
    void action(async () => {
      await api.employeeForms.create({ memberId }, drafts);
      setDrafts([]);
    }, "Requests sent.");
  }

  return (
    <form className="requirementAssignment" onSubmit={assign}>
      <RequirementDraftEditor
        drafts={drafts}
        disabled={busy}
        onChange={setDrafts}
      />
      <Button
        busy={busy}
        disabled={!drafts.length}
        type="submit"
        variant="primary"
      >
        Send requests
      </Button>
    </form>
  );
}

type RequirementAction = <T>(
  work: () => Promise<T>,
  success: string | ((result: T) => string),
) => Promise<void>;

function RequirementItem({
  action,
  busy,
  requirement,
  showTarget,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
  /** Name the person when the list is not already one person's page. */
  showTarget: boolean;
}) {
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const locked = screeningLocked(requirement);
  const badge = requirementBadge(requirement);
  return (
    <li className="requirementItem">
      <div className="requirementItemHeader">
        <div>
          <strong>{requirement.title}</strong>
          {showTarget && (
            <span className="rowMeta">
              {" "}
              · {requirement.targetName ?? requirement.targetEmail}
              {requirement.invitationId ? " (invited)" : ""}
            </span>
          )}
          <span className="rowMeta">
            {" "}
            · Due {formatCalendarDate(requirement.dueDate)}
          </span>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {requirement.checkrResult && (
        <CheckrResult
          completedAt={requirement.completedAt}
          result={requirement.checkrResult}
        />
      )}
      <div className="requirementActions">
        <RequirementDocumentControl
          action={action}
          busy={busy}
          onDownloaded={setReviewedRevision}
          requirement={requirement}
        />
        {/* Credit reports ordered through hosted invitations still refresh. */}
        {((requirement.kind === "background_check" &&
          (requirement.checkrAvailable ||
            requirement.checkrRequested ||
            requirement.checkrSubmitting)) ||
          requirement.checkrReportStatus) && (
          <CheckrControl
            action={action}
            busy={busy}
            requirement={requirement}
          />
        )}
        {(requirement.kind === "form" ||
          (!requirement.checkrAvailable && !locked) ||
          isClosedReportStatus(requirement.checkrReportStatus)) && (
          <RequirementStatusControl
            action={action}
            busy={busy}
            requirement={requirement}
            reviewedRevision={reviewedRevision}
          />
        )}
        <input
          aria-label={`Due date for ${requirement.title}`}
          className="input inputSm"
          disabled={busy}
          onChange={(event) =>
            void action(
              () =>
                api.employeeForms.update(requirement.id, {
                  dueDate: event.target.value,
                }),
              "Due date updated.",
            )
          }
          type="date"
          value={requirement.dueDate}
        />
        {!locked && (
          <Button
            disabled={busy}
            onClick={() =>
              void action(
                () => api.employeeForms.delete(requirement.id),
                "Requirement removed.",
              )
            }
            size="sm"
            variant="danger"
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

function ConsentDownload({
  action,
  busy,
  id,
}: {
  action: RequirementAction;
  busy: boolean;
  id: string;
}) {
  return (
    <Button
      disabled={busy}
      onClick={() =>
        void action(() => downloadScreeningConsent(id), "Download started.")
      }
      size="sm"
      variant="ghost"
    >
      Signed authorization
    </Button>
  );
}

function CheckrControl({
  action,
  busy,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
}) {
  const status = requirement.checkrReportStatus;
  if (status && !isClosedReportStatus(status)) {
    return (
      <CheckrReportControl
        action={action}
        busy={busy}
        requirement={requirement}
      />
    );
  }
  // Checkr orders only background checks now; a hosted credit report that was
  // canceled is tracked by hand.
  if (requirement.kind !== "background_check") return null;
  // A submission Checkr did not finish resumes when the person submits again.
  if (requirement.checkrSubmitting) {
    return (
      <span className="rowMeta">
        Waiting for{" "}
        {requirement.targetName ?? requirement.targetEmail ?? "the person"} to
        finish submitting
      </span>
    );
  }
  return (
    <CheckrRequestControl
      action={action}
      busy={busy}
      requirement={requirement}
    />
  );
}

function CheckrReportControl({
  action,
  busy,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
}) {
  return (
    <>
      <Button
        disabled={busy}
        onClick={() =>
          void action(
            () => api.employeeForms.refreshScreening(requirement.id),
            "Checkr status refreshed.",
          )
        }
        size="sm"
      >
        Refresh check
      </Button>
      {requirement.hasCheckrConsent && (
        <ConsentDownload action={action} busy={busy} id={requirement.id} />
      )}
    </>
  );
}

/** Asks the person to complete a check, or changes a waiting request. */
function CheckrRequestControl({
  action,
  busy,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
}) {
  const [state, setState] = useState(
    requirement.checkrWorkLocation?.state ?? "",
  );
  const [city, setCity] = useState(requirement.checkrWorkLocation?.city ?? "");
  const stateCode = isUsStateCode(state) ? state : null;
  const person = requirement.targetName ?? requirement.targetEmail ?? "them";
  return (
    <div className="checkrStart">
      <input
        aria-label={`Work state for ${requirement.title}`}
        autoCapitalize="characters"
        className="input inputSm checkrState"
        disabled={busy}
        maxLength={2}
        onChange={(event) => setState(event.target.value.toUpperCase())}
        placeholder="State"
        value={state}
      />
      <input
        aria-label={`Work city for ${requirement.title}`}
        className="input inputSm checkrCity"
        disabled={busy}
        maxLength={employeeRequirementLimits.city}
        onChange={(event) => setCity(event.target.value)}
        placeholder="City (optional)"
        value={city}
      />
      <Button
        disabled={busy || !stateCode}
        onClick={() => {
          if (!stateCode) return;
          void action(
            () =>
              api.employeeForms.requestScreening(
                requirement.id,
                stateCode,
                city,
              ),
            ({ emailed }) =>
              emailed
                ? `Background check requested. ${person} was emailed a link.`
                : `Background check requested, but the email to ${person} couldn’t be sent. Ask them to open Forms and checks in Balebase.`,
          );
        }}
        size="sm"
      >
        {requirement.checkrRequested
          ? "Update request"
          : requirement.checkrReportStatus
            ? "Request again"
            : "Request background check"}
      </Button>
    </div>
  );
}

function CheckrResult({
  completedAt,
  result,
}: {
  completedAt: string | null;
  result: string;
}) {
  return (
    <div className="checkrResult">
      <Badge tone={checkrResultTone(result)}>
        Checkr result: {formatCheckrResult(result)}
      </Badge>
      {completedAt && (
        <span className="rowMeta">Completed {formatDate(completedAt)}</span>
      )}
      {result === "consider" && (
        <p className="rowMeta">
          The report found records to review. Review it in Checkr before making
          a decision.
        </p>
      )}
    </div>
  );
}

function RequirementDocumentControl({
  action,
  busy,
  onDownloaded,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  onDownloaded: (revision: number) => void;
  requirement: EmployeeRequirement;
}) {
  return (
    <>
      {requirement.kind === "form" && requirement.memberId && (
        <label className="requirementUpload">
          <span>
            {requirement.hasDocument ? "Replace file" : "Upload file"}
          </span>
          <input
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void action(
                  () => api.employeeForms.upload(requirement.id, file),
                  "Form submitted.",
                );
              }
              event.target.value = "";
            }}
            type="file"
          />
        </label>
      )}
      {requirement.hasDocument && (
        <Button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const revision = await downloadEmployeeForm(
                requirement.id,
                requirement.documentFilename ?? "form",
              );
              onDownloaded(revision);
            }, "Download started.")
          }
          size="sm"
          variant="ghost"
        >
          Download {requirement.documentFilename}
        </Button>
      )}
    </>
  );
}

function RequirementStatusControl({
  action,
  busy,
  requirement,
  reviewedRevision,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
  reviewedRevision: number | null;
}) {
  if (requirement.kind === "form" && !requirement.hasDocument) return null;
  return (
    <Select
      aria-label={`Status for ${requirement.title}`}
      className="inputSm"
      disabled={busy}
      onChange={(event) =>
        void action(
          () =>
            api.employeeForms.update(requirement.id, {
              documentRevision: reviewRevisionForStatus(
                requirement.kind,
                requirement.documentRevision,
                reviewedRevision,
                event.target.value as EmployeeRequirementStatus,
              ),
              status: event.target.value as EmployeeRequirementStatus,
            }),
          "Status updated.",
        )
      }
      value={requirement.status}
    >
      <option value="pending">Pending</option>
      {requirement.kind === "form" ? (
        <option value="submitted">Submitted</option>
      ) : (
        <option value="in_progress">In progress</option>
      )}
      <option
        disabled={
          !canCompleteRequirement(
            requirement.kind,
            requirement.documentRevision,
            reviewedRevision,
          )
        }
        value="complete"
      >
        Complete
      </option>
    </Select>
  );
}

function scopeDescription(scope: RequirementScope) {
  return scope.kind === "unattached"
    ? "Requests for people who haven’t accepted their invitation yet, or who have left the organization."
    : "Request tax forms, set due dates, request Checkr background checks, and track credit checks.";
}

/** Submitted to Checkr, or being submitted, and not canceled. */
function screeningLocked(requirement: EmployeeRequirement) {
  return (
    requirement.checkrSubmitting ||
    (requirement.checkrReportStatus !== null &&
      !isClosedReportStatus(requirement.checkrReportStatus))
  );
}

function checkrResultTone(result: string) {
  if (result === "clear") return "success";
  if (result === "consider") return "warning";
  return "neutral";
}

function formatCheckrResult(result: string) {
  return result
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
