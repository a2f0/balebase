import {
  Button,
  Card,
  cx,
  Icon,
  Page,
  PageBody,
  Toast,
} from "@balebase/ui/react";
import type {
  AuditDetail,
  AuditIssue,
  AuditRun,
} from "@balebase/validators/audits";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ActivityFeed } from "./ActivityFeed";
import { AuditChecklist } from "./AuditChecklist";
import {
  confirmDiscard,
  RunHeader,
  RunLoading,
  RunOverview,
} from "./AuditRunHeader";
import { AuditIssuePanel } from "./AuditRunIssues";
import { progressFor } from "./auditProgress";
import { api } from "./shared/apiClient";
import { errorMessage } from "./shared/errors";
import { countLabel, formatDate } from "./shared/labels";
import { useAction } from "./shared/useAction";

interface AuditRunPageProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

interface RunState {
  detail: AuditDetail | undefined;
  responses: Record<string, string>;
}

type RunAction =
  | { deletedAt: string; type: "discarded" }
  | { detail: AuditDetail; type: "loaded" }
  | { detail: AuditDetail; type: "issuesRefreshed" }
  | { itemId: string; response: string; type: "answered" };

/**
 * The run page's audit and answers. Issue changes refresh the audit without
 * discarding unsaved answers, so a Fail survives raising its issue.
 */
export function runStateReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "loaded":
      return {
        detail: action.detail,
        responses: action.detail.audit.responses,
      };
    case "issuesRefreshed":
      return {
        ...state,
        detail: {
          ...action.detail,
          audit: state.detail?.audit ?? action.detail.audit,
        },
      };
    case "answered":
      return {
        ...state,
        responses: { ...state.responses, [action.itemId]: action.response },
      };
    // Read-only at once, even if the reload that follows fails; unsaved
    // answers were not kept, so show the saved ones.
    case "discarded":
      return state.detail
        ? {
            detail: {
              ...state.detail,
              audit: { ...state.detail.audit, deletedAt: action.deletedAt },
            },
            responses: state.detail.audit.responses,
          }
        : state;
  }
}

/**
 * The run and its unsaved answers. The reducer keeps those answers across
 * issue refreshes, so this guards its own requests instead of using useLoad.
 */
function useAuditRun(id: string) {
  const [{ detail, responses }, dispatch] = useReducer(runStateReducer, {
    detail: undefined,
    responses: {},
  });
  const [loadError, setLoadError] = useState<string>();
  const latest = useRef(0);

  const fetchRun = useCallback(
    async (type: "issuesRefreshed" | "loaded") => {
      const request = ++latest.current;
      try {
        const next = await api.audits.getRun(id);
        if (request !== latest.current) return;
        dispatch({ detail: next, type });
        if (type === "loaded") setLoadError(undefined);
      } catch (cause) {
        if (request === latest.current)
          setLoadError(errorMessage(cause, "Could not load the audit."));
      }
    },
    [id],
  );
  const load = useCallback(() => fetchRun("loaded"), [fetchRun]);
  const refreshIssues = useCallback(
    () => fetchRun("issuesRefreshed"),
    [fetchRun],
  );

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);
  return { detail, dispatch, load, loadError, refreshIssues, responses };
}

export function AuditRunPage({ id, onNavigate }: AuditRunPageProps) {
  const { detail, dispatch, load, loadError, refreshIssues, responses } =
    useAuditRun(id);
  const { busy, notice, run, ...action } = useAction("Could not update audit.");
  const error = action.error ?? loadError;

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
          responses={responses}
        />
        <ActivityFeed refreshKey={detail} source={{ id, type: "audit_run" }} />
      </PageBody>
    </Page>
  );
}

/** The checklist and its issues; a discarded audit shows them read-only. */
function RunWork({
  auditId,
  detail,
  onAnswer,
  onIssuesChanged,
  responses,
}: {
  auditId: string;
  detail: AuditDetail;
  onAnswer: (itemId: string, response: string) => void;
  onIssuesChanged: () => Promise<void>;
  responses: Record<string, string>;
}) {
  return (
    // A disabled fieldset turns every answer and issue control read-only.
    <fieldset
      className="fieldset runEditable"
      disabled={Boolean(detail.audit.deletedAt)}
    >
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
      />
      <AuditIssuePanel
        auditId={auditId}
        definition={detail.audit.definition}
        issues={detail.issues}
        members={detail.members}
        onChange={onIssuesChanged}
        responses={responses}
      />
    </fieldset>
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
