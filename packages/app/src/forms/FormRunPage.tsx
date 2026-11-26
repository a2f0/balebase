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
  FormDetail,
  FormIssue,
  FormRun,
} from "@balebase/validators/forms";
import { type ReactNode, useMemo } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { balebase } from "../balebase";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { FormQuestions } from "./FormQuestions";
import {
  confirmDiscard,
  RunHeader,
  RunLoading,
  RunOverview,
} from "./FormRunHeader";
import { FormIssuePanel } from "./FormRunIssues";
import { progressFor } from "./formProgress";
import type { FormRunReload } from "./formRunFetch";
import { useFormRun } from "./useFormRun";

interface FormRunPageProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

export function FormRunPage({ id, onNavigate }: FormRunPageProps) {
  const { detail, dispatch, load, loadError, refreshIssues, responses } =
    useFormRun(id);
  const { busy, notice, run, ...action } = useAction("Could not update form.");
  const error = action.error ?? loadError;
  const sections = useRunSections();

  /**
   * Runs a change, then reloads the form so the page shows what was stored,
   * as `reload` says (after a save, keeping answers changed since it).
   */
  async function perform(
    change: () => Promise<unknown>,
    success: string,
    reload?: FormRunReload,
  ) {
    await run(async () => {
      await change();
      await load(reload);
    }, success);
  }

  async function save(status: "completed" | "in_progress") {
    if (!detail) return;
    const { revision } = detail.form;
    await perform(
      () => balebase().api.forms.saveRun(id, responses, status, revision),
      status === "completed" ? "Form completed." : "Form saved.",
      { keepSince: responses },
    );
  }

  async function discard() {
    if (!detail || !(await confirmDiscard(detail.form.templateName))) return;
    await perform(async () => {
      const { deletedAt } = await balebase().api.forms.discardRun(id);
      dispatch({ deletedAt, type: "discarded" });
    }, "Form discarded.");
  }

  if (!detail) {
    return <RunLoading error={error} onBack={() => onNavigate("/forms")} />;
  }

  const { deletedAt } = detail.form;
  return (
    <Page>
      <RunHeader
        busy={busy}
        discarded={Boolean(deletedAt)}
        error={error}
        name={detail.form.templateName}
        onBack={() => onNavigate(deletedAt ? "/forms?view=deleted" : "/forms")}
        notice={notice}
        onSave={save}
        status={detail.form.status}
        tabs={sections.tabs}
        templateVersion={detail.form.templateVersion}
      />
      <PageBody className="runBody">
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        <RunOverview form={detail.form} busy={busy} onDiscard={discard} />
        {error && (
          <Button
            onClick={() => {
              action.setError(undefined);
              void load();
            }}
            size="sm"
          >
            Reload form
          </Button>
        )}
        <RunProgress
          form={detail.form}
          issues={detail.issues}
          responses={responses}
        />
        <RunWork
          formId={id}
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
            source={{ id, type: "form_run" }}
          />,
        )}
      </PageBody>
    </Page>
  );
}

/** The form's questions, issues, and history, each on its own tab. */
function useRunSections() {
  return useSectionTabs([
    { id: "questions", label: "Questions" },
    { id: "issues", label: "Issues" },
    { id: "activity", label: "Activity" },
  ] as const);
}

/** The questions and their issues; a discarded form shows them read-only. */
function RunWork({
  formId,
  detail,
  onAnswer,
  onIssuesChanged,
  panel,
  responses,
}: {
  formId: string;
  detail: FormDetail;
  onAnswer: (itemId: string, response: string) => void;
  onIssuesChanged: () => Promise<void>;
  panel: ReturnType<typeof useRunSections>["panel"];
  responses: Record<string, string>;
}) {
  // A disabled fieldset turns every answer and issue control read-only.
  const editable = (children: ReactNode) => (
    <fieldset
      className="fieldset runEditable"
      disabled={Boolean(detail.form.deletedAt)}
    >
      {children}
    </fieldset>
  );
  return (
    <>
      {panel(
        "questions",
        editable(
          <FormQuestions
            definition={detail.form.definition}
            issueContext={{
              form: detail.form,
              formId,
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
          <FormIssuePanel
            formId={formId}
            definition={detail.form.definition}
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
  form,
  issues,
  responses,
}: {
  form: FormRun;
  issues: FormIssue[];
  responses: Record<string, string>;
}) {
  const { answered, failed, requiredLeft, total } = useMemo(
    () => progressFor(form.definition, responses),
    [form.definition, responses],
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
          <ProgressNote form={form} requiredLeft={requiredLeft} />
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
  form,
  requiredLeft,
}: {
  form: FormRun;
  requiredLeft: number;
}) {
  if (form.status === "completed") {
    return (
      <p className="runProgressNote runProgressDone">
        <Icon name="success" size={16} />
        <span>
          Completed
          {form.completedAt ? ` ${formatDate(form.completedAt)}` : ""}
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
        ? `${countLabel(requiredLeft, "required question")} left before this form can be completed.`
        : "All required questions are answered."}
    </p>
  );
}
