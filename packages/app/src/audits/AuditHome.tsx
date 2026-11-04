import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Icon,
  type IconName,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  AuditRunView,
  AuditSummary,
  AuditTemplate,
  AuditTemplateSummary,
} from "@balebase/validators/audits";
import { useCallback, useEffect, useState } from "react";
import { ErrorToast } from "../billing/ErrorToast";
import { api } from "../shared/apiClient";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useCursorPages } from "../shared/useCursorPages";
import { useLoad } from "../shared/useLoad";
import { auditRunPath, auditTemplatePath } from "../workspace/workspacePaths";
import {
  type AuditTemplateView,
  readAuditTemplateView,
  storeAuditTemplateView,
} from "./auditTemplateView";
import {
  TemplateCollections,
  TemplateViewSwitcher,
} from "./TemplateCollections";

export function AuditHome({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const templates = useLoad(
    useCallback(async () => (await api.audits.listTemplates()).templates, []),
    "Could not load audits.",
  );
  const creating = useAction("Could not create the checklist.");
  const starting = useAction("Could not start the audit.");
  const busy = creating.busy || starting.busy;
  const error = creating.failure ?? starting.failure;
  const [templateView, setTemplateView] = useState(() =>
    readAuditTemplateView(),
  );
  const runList = useAuditRunList();

  async function createTemplate() {
    starting.setError(undefined);
    await creating.run(async () => {
      const { template } =
        await api.audits.createTemplate("Untitled checklist");
      onNavigate(auditTemplatePath(template.id));
    });
  }

  async function beginAudit(templateId: string) {
    creating.setError(undefined);
    await starting.run(async () => {
      const { auditId } = await api.audits.start(templateId);
      onNavigate(auditRunPath(auditId));
    });
  }

  function changeTemplateView(view: AuditTemplateView) {
    setTemplateView(view);
    storeAuditTemplateView(view);
  }

  return (
    <Page>
      <AuditHomeHeader busy={busy} onCreate={createTemplate} />
      <PageBody>
        <ErrorToast error={error} onNavigate={onNavigate} />
        {templates.error && <Toast tone="danger">{templates.error}</Toast>}
        <TemplateLibrary
          busy={busy}
          onBegin={beginAudit}
          onEdit={(id) => onNavigate(auditTemplatePath(id))}
          onViewChange={changeTemplateView}
          templates={templates.data}
          view={templateView}
        />
        <AuditHistory
          error={runList.error}
          loadingMore={runList.loadingMore}
          nextCursor={runList.nextCursor}
          onLoadMore={runList.loadMore}
          onOpen={(id) => onNavigate(auditRunPath(id))}
          onViewChange={runList.changeView}
          runs={runList.items}
          view={runList.view}
        />
      </PageBody>
    </Page>
  );
}

/**
 * Active or deleted audit runs, paged. `?view=deleted` opens the deleted list
 * once (Back from a discarded audit) and then leaves the address.
 */
function useAuditRunList() {
  const [view, setView] = useState<AuditRunView>(() =>
    new URLSearchParams(window.location.search).get("view") === "deleted"
      ? "deleted"
      : "active",
  );

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", "/audits");
    }
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await api.audits.listRuns(cursor, view);
      return { items: page.audits, nextCursor: page.nextCursor };
    },
    [view],
  );
  return {
    ...useCursorPages(fetchPage, "Could not load audits."),
    changeView: setView,
    view,
  };
}

function AuditHomeHeader({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: () => Promise<void>;
}) {
  return (
    <PageHeader
      actions={
        <Button
          disabled={busy}
          icon="add"
          onClick={() => void onCreate()}
          variant="primary"
        >
          New organization checklist
        </Button>
      }
      description="Run inspections from shared or organization checklists and keep every finding in one place."
      eyebrow="Inspections & compliance"
      title="Audits"
    />
  );
}

interface TemplateActions {
  busy: boolean;
  onBegin: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
}

const libraryCopy = {
  global: {
    description: "Available in every organization.",
    emptyMessage: "No global checklists are available yet.",
    emptyTitle: "No global forms",
    title: "Global forms",
  },
  organization: {
    description: "Private to the active organization.",
    emptyMessage:
      "No forms have been created for this organization yet. Customize a global form or start a new checklist.",
    emptyTitle: "No organization forms yet",
    title: "Organization forms",
  },
};

function TemplateLibrary({
  onViewChange,
  templates,
  view,
  ...actions
}: TemplateActions & {
  onViewChange: (view: AuditTemplateView) => void;
  templates: AuditTemplateSummary[] | undefined;
  view: AuditTemplateView;
}) {
  return (
    <PageSection
      actions={
        <div className="auditTemplateToolbar">
          {templates && (
            <span className="sectionCount">
              {countLabel(templates.length, "template")}
            </span>
          )}
          <TemplateViewSwitcher onChange={onViewChange} view={view} />
        </div>
      }
      title="Checklist templates"
    >
      {templates ? (
        <TemplateCollections
          actions={(template, layout) => (
            <TemplateButtons {...actions} layout={layout} template={template} />
          )}
          copy={libraryCopy}
          templates={templates}
          view={view}
        />
      ) : (
        <LoadingState label="Loading checklists…" />
      )}
    </PageSection>
  );
}

/** Edit or customize a form, and start an audit from it. */
function TemplateButtons({
  busy,
  layout,
  onBegin,
  onEdit,
  template,
}: TemplateActions & { layout: AuditTemplateView; template: AuditTemplate }) {
  const edit = (
    <Button icon="edit" onClick={() => onEdit(template.id)} size="sm">
      {template.scope === "global" ? "Customize" : "Edit"}
    </Button>
  );
  const start = (
    <Button
      className={layout === "grid" ? "auditTemplateStart" : undefined}
      disabled={busy}
      iconEnd="arrowRight"
      onClick={() => void onBegin(template.id)}
      size="sm"
      variant="primary"
    >
      Start audit
    </Button>
  );
  return layout === "grid" ? (
    <>
      <div className="cluster auditTemplateActions">{edit}</div>
      {start}
    </>
  ) : (
    <>
      {edit}
      {start}
    </>
  );
}

const runViews: { icon: IconName; label: string; view: AuditRunView }[] = [
  { icon: "audits", label: "Active", view: "active" },
  { icon: "trash", label: "Deleted", view: "deleted" },
];

function AuditHistory({
  error,
  loadingMore,
  nextCursor,
  onLoadMore,
  onOpen,
  onViewChange,
  runs,
  view,
}: {
  error: string | undefined;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => Promise<boolean>;
  onOpen: (id: string) => void;
  onViewChange: (view: AuditRunView) => void;
  runs: AuditSummary[] | undefined;
  view: AuditRunView;
}) {
  const hasMore = Boolean(nextCursor);
  return (
    <PageSection
      actions={
        <div className="auditRunToolbar">
          {runs && (
            <span className="sectionCount">
              {runs.length}
              {hasMore ? "+" : ""}{" "}
              {runs.length === 1 && !hasMore ? "audit" : "audits"}
            </span>
          )}
          <nav aria-label="Audit lists" className="segmented">
            {runViews.map((option) => (
              <button
                aria-pressed={view === option.view}
                key={option.view}
                onClick={() => onViewChange(option.view)}
                type="button"
              >
                <Icon name={option.icon} size={16} />
                {option.label}
              </button>
            ))}
          </nav>
        </div>
      }
      title={view === "deleted" ? "Deleted audits" : "Recent audits"}
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {runs?.length ? (
        <Card
          className="auditRunCard"
          flush
          footer={
            nextCursor && (
              <InfiniteScroll
                autoLoad={!error}
                busy={loadingMore}
                cursor={nextCursor}
                onLoadMore={onLoadMore}
              >
                Load more audits
              </InfiniteScroll>
            )
          }
        >
          <div className="rowList">
            {runs.map((run) => (
              <AuditRunRow key={run.id} onOpen={onOpen} run={run} />
            ))}
          </div>
        </Card>
      ) : runs && view === "deleted" ? (
        <EmptyState compact icon="trash" title="No deleted audits">
          Discarded audits will appear here.
        </EmptyState>
      ) : runs ? (
        <EmptyState compact icon="audits" title="No audits yet">
          Start one from a checklist above.
        </EmptyState>
      ) : (
        !error && <LoadingState label="Loading audits…" />
      )}
    </PageSection>
  );
}

function AuditRunRow({
  onOpen,
  run,
}: {
  onOpen: (id: string) => void;
  run: AuditSummary;
}) {
  return (
    <button
      className="row auditRunRow"
      onClick={() => onOpen(run.id)}
      type="button"
    >
      <span className="rowMain">
        <span className="rowTitle">{run.templateName}</span>
        <span className="rowMeta">
          {run.templateVersion ? `v${run.templateVersion} · ` : ""}
          {run.deletedAt
            ? `Discarded ${formatDate(run.deletedAt)}${run.deletedBy ? ` by ${run.deletedBy.name}` : ""}`
            : `${formatDate(run.updatedAt)} · Started by ${run.createdBy.name}`}
        </span>
      </span>
      <span className="auditRunStats">
        <Badge dot tone={runTone(run)}>
          {status(run)}
        </Badge>
        <span className="auditRunStat">
          <Icon name="check" size={16} />
          {run.responseCount} answered
        </span>
        <span className="auditRunStat">
          <Icon name="issues" size={16} />
          {countLabel(run.issueCount, "issue")}
        </span>
      </span>
      <Icon className="auditRunArrow" name="arrowRight" />
    </button>
  );
}

function status(run: AuditSummary) {
  if (run.deletedAt) return "Discarded";
  return run.status === "completed" ? "Completed" : "In progress";
}

function runTone(run: AuditSummary): BadgeTone {
  if (run.deletedAt) return "danger";
  return run.status === "completed" ? "success" : "warning";
}
