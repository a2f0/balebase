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
import type { FormRun } from "@balebase/validators/forms";
import type { ReactNode } from "react";
import { formatDateTime, formatLabel } from "../shared/labels";

// The form run page's header, status line, and loading state.

export function RunHeader({
  busy,
  discarded,
  error,
  name,
  notice,
  onBack,
  onSave,
  status,
  tabs,
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
  tabs: ReactNode;
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
              {status === "completed" ? "Reopen form" : "Save"}
            </Button>
            <Button
              disabled={busy}
              icon="check"
              onClick={() => void onSave("completed")}
              variant="primary"
            >
              {status === "completed" ? "Save completed form" : "Complete form"}
            </Button>
          </div>
        )
      }
      back={<RunBackButton onBack={onBack} />}
      eyebrow={
        <>
          <span>Form</span>
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
      tabs={tabs}
      tabsKind="panels"
      tabsLabel="Form sections"
      title={name}
    />
  );
}

/** Who started the form, with how it was discarded or the action to discard it. */
export function RunOverview({
  form,
  busy,
  onDiscard,
}: {
  form: FormRun;
  busy: boolean;
  onDiscard: () => Promise<void>;
}) {
  const { deletedAt, deletedBy } = form;
  return (
    <>
      <div className="runOverview">
        <p className="runAttribution">
          {form.project.name}
          {form.project.deleted ? " (deleted project)" : ""} · Started by{" "}
          {form.createdBy.name} · {form.createdBy.email} ·{" "}
          {formatDateTime(form.createdAt)}
        </p>
        {!deletedAt && form.status === "in_progress" && (
          <Button
            disabled={busy}
            icon="trash"
            onClick={() => void onDiscard()}
            size="sm"
            variant="danger"
          >
            Discard form
          </Button>
        )}
      </div>
      {deletedAt && (
        <Banner announce={false} icon="trash" tone="warning">
          Discarded
          {deletedBy ? ` by ${deletedBy.name} · ${deletedBy.email}` : ""} ·{" "}
          {formatDateTime(deletedAt)}. A discarded form can't be changed.
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
      Forms
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
        eyebrow="Form"
        title={error ? "Form unavailable" : "Form"}
      />
      <PageBody>
        {error ? (
          <Banner
            actions={
              <Button onClick={onBack} size="sm">
                Return to forms
              </Button>
            }
            tone="danger"
          >
            {error}
          </Banner>
        ) : (
          <LoadingState label="Loading form…" />
        )}
      </PageBody>
    </Page>
  );
}

export function confirmDiscard(name: string) {
  return confirmDialog({
    confirmLabel: "Discard form",
    message:
      "It moves to Deleted forms, where it stays read-only. Unsaved answers are lost.",
    title: `Discard “${name}”?`,
    tone: "danger",
  });
}
