import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Field,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  createEmployeeRequirements,
  deleteEmployeeRequirement,
  downloadEmployeeForm,
  downloadScreeningConsent,
  type EmployeeRequirement,
  type EmployeeRequirementKind,
  type EmployeeRequirementStatus,
  listEmployeeRequirements,
  type RequirementDraft,
  refreshCheckrScreening,
  requestCheckrScreening,
  updateEmployeeRequirement,
  uploadEmployeeForm,
} from "./employeeFormsApi";
import {
  canCompleteRequirement,
  reviewRevisionForStatus,
} from "./employeeOnboarding";
import { organizationScreeningPath } from "./organizationState";
import { handleNavigation } from "./workspacePaths";

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
    if (!title || !dueDate || drafts.length >= 20) return;
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
          <select
            className="select"
            disabled={disabled}
            onChange={(event) => setOptionIndex(Number(event.target.value))}
            value={optionIndex}
          >
            {options.map((option, index) => (
              <option key={`${option.kind}-${option.title}`} value={index}>
                {option.title}
              </option>
            ))}
          </select>
        </Field>
        {selected.title === "Other form" && (
          <Field label="Form name">
            <input
              className="input"
              disabled={disabled}
              maxLength={100}
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
            drafts.length >= 20
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
                {draft.title} · Due {formatDate(draft.dueDate)}
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
 * Requested forms and checks in one scope. On a member's page, managers also
 * request new ones; requests without a member page keep every other control.
 */
export function EmployeeForms({
  canManage,
  onNavigate,
  scope,
}: {
  canManage: boolean;
  /** Opens the person's own screening form; omit where no one completes one. */
  onNavigate?: ((pathname: string) => void) | undefined;
  scope: RequirementScope;
}) {
  // Compared by value, so a new scope object for the same people is no change.
  const scopeKey = JSON.stringify(scope);
  const [requirements, setRequirements] = useState<EmployeeRequirement[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = JSON.parse(scopeKey) as RequirementScope;
      const all = await listEmployeeRequirements();
      setRequirements(all.filter((item) => inRequirementScope(current, item)));
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [scopeKey]);
  useEffect(() => {
    setRequirements(undefined);
    void load();
  }, [load]);

  async function action<T>(
    work: () => Promise<T>,
    success: string | ((result: T) => string),
  ) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await work();
      await load();
      setNotice(typeof success === "string" ? success : success(result));
    } catch (cause) {
      const message = messageFrom(cause);
      setRequirements(undefined);
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description={scopeDescription(scope, canManage)}
      title={
        scope.kind === "member"
          ? "Forms and checks"
          : "Invitees and former members"
      }
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {canManage && scope.kind === "member" && (
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
              canManage={canManage}
              key={requirement.id}
              onNavigate={onNavigate}
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
      await createEmployeeRequirements({ memberId }, drafts);
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
  canManage,
  onNavigate,
  requirement,
  showTarget,
}: {
  action: RequirementAction;
  busy: boolean;
  canManage: boolean;
  onNavigate: ((pathname: string) => void) | undefined;
  requirement: EmployeeRequirement;
  /** Name the person when the list is not already one person's page. */
  showTarget: boolean;
}) {
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const locked = screeningLocked(requirement);
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
            · Due {formatDate(requirement.dueDate)}
          </span>
        </div>
        <Badge tone={statusTone(requirement.status)}>
          {formatStatus(requirement.status)}
        </Badge>
      </div>
      {canManage && requirement.checkrResult && (
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
        <OwnScreeningControl
          action={action}
          busy={busy}
          canManage={canManage}
          onNavigate={onNavigate}
          requirement={requirement}
        />
        {canManage && (
          <>
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
                    updateEmployeeRequirement(requirement.id, {
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
                    () => deleteEmployeeRequirement(requirement.id),
                    "Requirement removed.",
                  )
                }
                size="sm"
                variant="danger"
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The person's side of a background check: a link to their screening form
 * while it waits for them, then their signed authorization.
 */
function OwnScreeningControl({
  action,
  busy,
  canManage,
  onNavigate,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  canManage: boolean;
  onNavigate: ((pathname: string) => void) | undefined;
  requirement: EmployeeRequirement;
}) {
  if (requirement.canSubmitCheckr && requirement.memberId && onNavigate) {
    const path = organizationScreeningPath(
      requirement.memberId,
      requirement.id,
    );
    return (
      <ButtonLink
        href={path}
        onClick={(event) => handleNavigation(event, path, onNavigate)}
        size="sm"
        variant="primary"
      >
        Complete background check
      </ButtonLink>
    );
  }
  if (canManage || !requirement.checkrReportStatus) return null;
  return (
    <>
      <span className="rowMeta">Submitted to Checkr</span>
      {requirement.hasCheckrConsent && (
        <ConsentDownload action={action} busy={busy} id={requirement.id} />
      )}
    </>
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
        status={status}
      />
    );
  }
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
  status,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
  status: string;
}) {
  return (
    <>
      {!(status === "complete" && requirement.checkrResult) && (
        <span className="rowMeta">Checkr: {formatCheckrStatus(status)}</span>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          void action(
            () => refreshCheckrScreening(requirement.id),
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
  const status = requirement.checkrReportStatus;
  const person = requirement.targetName ?? requirement.targetEmail ?? "them";
  return (
    <div className="checkrStart">
      {(requirement.checkrRequested || status) && (
        <span className="rowMeta">
          {requirement.checkrRequested
            ? `Waiting for ${person}’s details`
            : `Checkr: ${formatCheckrStatus(status ?? "")}`}
        </span>
      )}
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
        maxLength={100}
        onChange={(event) => setCity(event.target.value)}
        placeholder="City (optional)"
        value={city}
      />
      <Button
        disabled={busy || !/^[A-Z]{2}$/.test(state)}
        onClick={() =>
          void action(
            () => requestCheckrScreening(requirement.id, state, city),
            ({ emailed }) =>
              emailed
                ? `Background check requested. ${person} was emailed a link.`
                : `Background check requested, but the email to ${person} couldn’t be sent. Ask them to open Forms and checks in Balebase.`,
          )
        }
        size="sm"
      >
        {requirement.checkrRequested
          ? "Update request"
          : status
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
        <span className="rowMeta">
          Completed {formatTimestamp(completedAt)}
        </span>
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
                  () => uploadEmployeeForm(requirement.id, file),
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
    <select
      aria-label={`Status for ${requirement.title}`}
      className="select inputSm"
      disabled={busy}
      onChange={(event) =>
        void action(
          () =>
            updateEmployeeRequirement(requirement.id, {
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
    </select>
  );
}

function scopeDescription(scope: RequirementScope, canManage: boolean) {
  if (scope.kind === "unattached") {
    return "Requests for people who haven’t accepted their invitation yet, or who have left the organization.";
  }
  return canManage
    ? "Request tax forms, set due dates, request Checkr background checks, and track credit checks."
    : "Forms and checks your organization has requested from you.";
}

// A canceled report frees the screening to be requested again.
function isClosedReportStatus(status: string | null) {
  return status === "canceled" || status === "partially_canceled";
}

/** Submitted to Checkr, or being submitted, and not canceled. */
function screeningLocked(requirement: EmployeeRequirement) {
  return (
    requirement.checkrSubmitting ||
    (requirement.checkrReportStatus !== null &&
      !isClosedReportStatus(requirement.checkrReportStatus))
  );
}

function formatCheckrStatus(status: string) {
  return status.replaceAll("_", " ");
}

function statusTone(status: EmployeeRequirementStatus) {
  if (status === "complete") return "success";
  if (status === "pending") return "warning";
  return "info";
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

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatStatus(status: EmployeeRequirementStatus) {
  return status
    .replace("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update requirements.";
}
