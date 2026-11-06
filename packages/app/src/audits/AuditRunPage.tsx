import {
  Button,
  Card,
  cx,
  Icon,
  Page,
  PageBody,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type {
  AuditDetail,
  AuditIssue,
  AuditRun,
} from "@balebase/validators/audits";
import { type ReactNode, useMemo } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { api } from "../shared/apiClient";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { AuditChecklist } from "./AuditChecklist";
import {
  confirmDiscard,
  RunHeader,
  RunLoading,
  RunOverview,
} from "./AuditRunHeader";
import { AuditIssuePanel } from "./AuditRunIssues";
import { progressFor } from "./auditProgress";
import { useAuditRun } from "./useAuditRun";

interface AuditRunPageProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

export function AuditRunPage({ id, onNavigate }: AuditRunPageProps) {
  const { detail, dispatch, load, loadError, refreshIssues, responses } =
    useAuditRun(id);
  const { busy, notice, run, ...action } = useAction("Could not update audit.");
  const error = action.error ?? loadError;
  const sections = useRunSections();

  /** Runs a change, then reloads the audit so the page shows what was stored. */
  async function perform(change: () => Promise<unknown>, success: string) {
    await run(async () => {
      await change();
      await load();
    }, success);
  }

  async function save(status: "completed" | "in_progress") {
    if (!detail) return;
    const { revision } = detail.audit;
    await perform(
      () => api.audits.saveRun(id, responses, status, revision),
      status === "completed" ? "Audit completed." : "Audit saved.",
    );
  }

  async function discard() {
    if (!detail || !(await confirmDiscard(detail.audit.templateName))) return;
    await perform(async () => {
      const { deletedAt } = await api.audits.discardRun(id);
      dispatch({ deletedAt, type: "discarded" });
    }, "Audit discarded.");
  }

  if (!detail) {
    return <RunLoading error={error} onBack={() => onNavigate("/audits")} />;
  }

  const { deletedAt } = detail.audit;
  return (
    <Page>
      <RunHeader
        busy={busy}
        discarded={Boolean(deletedAt)}
        error={error}
        name={detail.audit.templateName}
        onBack={() =>
          onNavigate(deletedAt ? "/audits?view=deleted" : "/audits")
        }
        notice={notice}
        onSave={save}
        status={detail.audit.status}
        tabs={sections.tabs}
        templateVersion={detail.audit.templateVersion}
      />
      <PageBody className="runBody">
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        <RunOverview audit={detail.audit} busy={busy} onDiscard={discard} />
        {error && (
          <Button
            onClick={() => {
              action.setError(undefined);
              void load();
            }}
            size="sm"
          >
            Reload audit
          </Button>
        )}
        <RunProgress
          audit={detail.audit}
          issues={detail.issues}
          responses={responses}
        />
        <RunWork
          auditId={id}
          detail={detail}
          onAnswer={(itemId, response) =>
            dispatch({ itemId, response, type: "answered" })
          }
          onIssuesChanged={refreshIssues}
          panel={sections.panel}
          responses={responses}
        />
        {sections.panel(
          "activity",
          <ActivityFeed
            refreshKey={detail}
            source={{ id, type: "audit_run" }}
          />,
        )}
      </PageBody>
    </Page>
  );
}

/** The audit's checklist, issues, and history, each on its own tab. */
function useRunSections() {
  return useSectionTabs([
    { id: "checklist", label: "Checklist" },
    { id: "issues", label: "Issues" },
    { id: "activity", label: "Activity" },
  ] as const);
}

/** The checklist and its issues; a discarded audit shows them read-only. */
function RunWork({
  auditId,
  detail,
  onAnswer,
  onIssuesChanged,
  panel,
  responses,
}: {
  auditId: string;
  detail: AuditDetail;
  onAnswer: (itemId: string, response: string) => void;
  onIssuesChanged: () => Promise<void>;
  panel: ReturnType<typeof useRunSections>["panel"];
  responses: Record<string, string>;
}) {
  // A disabled fieldset turns every answer and issue control read-only.
  const editable = (children: ReactNode) => (
    <fieldset
      className="fieldset runEditable"
      disabled={Boolean(detail.audit.deletedAt)}
    >
      {children}
    </fieldset>
  );
  return (
    <>
      {panel(
        "checklist",
        editable(
          <AuditChecklist
            definition={detail.audit.definition}
            issueContext={{
              audit: detail.audit,
              auditId,
              issues: detail.issues,
              members: detail.members,
              onCreated: onIssuesChanged,
            }}
            onChange={onAnswer}
            responses={responses}
          />,
        ),
      )}
      {panel(
        "issues",
        editable(
          <AuditIssuePanel
            auditId={auditId}
            definition={detail.audit.definition}
            issues={detail.issues}
            members={detail.members}
            onChange={onIssuesChanged}
            responses={responses}
          />,
        ),
      )}
    </>
  );
}

function RunProgress({
  audit,
  issues,
  responses,
}: {
  audit: AuditRun;
  issues: AuditIssue[];
  responses: Record<string, string>;
}) {
  const { answered, failed, requiredLeft, total } = useMemo(
    () => progressFor(audit.definition, responses),
    [audit.definition, responses],
  );
  // Floor, so the bar never reads 100% while a question is unanswered.
  const percent = total ? Math.floor((answered / total) * 100) : 0;
  const openIssues = issues.filter((issue) => issue.status === "open").length;
  return (
    <Card>
      <div className="runProgressLayout">
        <div className="runProgressMain">
          <div className="runProgressHeading">
            <p className="runProgressValue">
              {answered} of {total} answered
            </p>
            <span className="runProgressPercent">{percent}%</span>
          </div>
          <div aria-hidden="true" className="runProgressTrack">
            <span
              className="runProgressFill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <ProgressNote audit={audit} requiredLeft={requiredLeft} />
        </div>
        <dl className="runStats">
          <div className={cx(failed > 0 && "runStatDanger")}>
            <dt>Failed</dt>
            <dd>{failed}</dd>
          </div>
          <div>
            <dt>Open issues</dt>
            <dd>{openIssues}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

function ProgressNote({
  audit,
  requiredLeft,
}: {
  audit: AuditRun;
  requiredLeft: number;
}) {
  if (audit.status === "completed") {
    return (
      <p className="runProgressNote runProgressDone">
        <Icon name="success" size={16} />
        <span>
          Completed
          {audit.completedAt ? ` ${formatDate(audit.completedAt)}` : ""}
          <span className="runProgressHint">
            {" "}
            · Reopening it marks it in progress again.
          </span>
        </span>
      </p>
    );
  }
  return (
    <p className="runProgressNote">
      {requiredLeft > 0
        ? `${countLabel(requiredLeft, "required question")} left before this audit can be completed.`
        : "All required questions are answered."}
    </p>
  );
}
