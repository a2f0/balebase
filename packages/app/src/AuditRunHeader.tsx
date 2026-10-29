import {
  Badge,
  Banner,
  Button,
  confirmDialog,
  cx,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
} from "@balebase/ui/react";
import type { AuditRun } from "@balebase/validators/audits";
import { formatDateTime, formatLabel } from "./shared/labels";

// The audit run page's header, status line, and loading state.

export function RunHeader({
  busy,
  discarded,
  error,
  name,
  notice,
  onBack,
  onSave,
  status,
  templateVersion,
}: {
  busy: boolean;
  discarded: boolean;
  error: string | undefined;
  name: string;
  notice: string | undefined;
  onBack: () => void;
  onSave: (status: "completed" | "in_progress") => Promise<void>;
  status: string;
  templateVersion: number | null;
}) {
  // Mirrors the save result inside the phone action bar; the banners announce it.
  const feedback = error
    ? { text: error, tone: "danger" }
    : notice
      ? { text: notice, tone: "success" }
      : undefined;
  return (
    <PageHeader
      actions={
        discarded ? undefined : (
          <div className="runActions">
            {feedback && (
              <p
                aria-hidden="true"
                className={cx(
                  "runActionsFeedback",
                  feedback.tone === "danger" && "runActionsFeedbackDanger",
                )}
              >
                {feedback.text}
              </p>
            )}
            <Button disabled={busy} onClick={() => void onSave("in_progress")}>
              {status === "completed" ? "Reopen audit" : "Save"}
            </Button>
            <Button
              disabled={busy}
              icon="check"
              onClick={() => void onSave("completed")}
              variant="primary"
            >
              {status === "completed"
                ? "Save completed audit"
                : "Complete audit"}
            </Button>
          </div>
        )
      }
      back={<RunBackButton onBack={onBack} />}
      eyebrow={
        <>
          <span>Audit</span>
          {discarded ? (
            <Badge dot tone="danger">
              Discarded
            </Badge>
          ) : (
            <Badge dot tone={status === "completed" ? "success" : "warning"}>
              {formatLabel(status)}
            </Badge>
          )}
          {templateVersion ? <span>Template v{templateVersion}</span> : null}
        </>
      }
      title={name}
    />
  );
}

/** Who started the audit, with how it was discarded or the action to discard it. */
export function RunOverview({
  audit,
  busy,
  onDiscard,
}: {
  audit: AuditRun;
  busy: boolean;
  onDiscard: () => Promise<void>;
}) {
  const { deletedAt, deletedBy } = audit;
  return (
    <>
      <div className="runOverview">
        <p className="runAttribution">
          Started by {audit.createdBy.name} · {audit.createdBy.email} ·{" "}
          {formatDateTime(audit.createdAt)}
        </p>
        {!deletedAt && audit.status === "in_progress" && (
          <Button
            disabled={busy}
            icon="trash"
            onClick={() => void onDiscard()}
            size="sm"
            variant="danger"
          >
            Discard audit
          </Button>
        )}
      </div>
      {deletedAt && (
        <Banner announce={false} icon="trash" tone="warning">
          Discarded
          {deletedBy ? ` by ${deletedBy.name} · ${deletedBy.email}` : ""} ·{" "}
          {formatDateTime(deletedAt)}. A discarded audit can't be changed.
        </Banner>
      )}
    </>
  );
}

function RunBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      className="runBack"
      icon="arrowLeft"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      Audits
    </Button>
  );
}

export function RunLoading({
  error,
  onBack,
}: {
  error: string | undefined;
  onBack: () => void;
}) {
  return (
    <Page>
      <PageHeader
        back={<RunBackButton onBack={onBack} />}
        eyebrow="Audit"
        title={error ? "Audit unavailable" : "Audit"}
      />
      <PageBody>
        {error ? (
          <Banner
            actions={
              <Button onClick={onBack} size="sm">
                Return to audits
              </Button>
            }
            tone="danger"
          >
            {error}
          </Banner>
        ) : (
          <LoadingState label="Loading audit…" />
        )}
      </PageBody>
    </Page>
  );
}

export function confirmDiscard(name: string) {
  return confirmDialog({
    confirmLabel: "Discard audit",
    message:
      "It moves to Deleted audits, where it stays read-only. Unsaved answers are lost.",
    title: `Discard “${name}”?`,
    tone: "danger",
  });
}
