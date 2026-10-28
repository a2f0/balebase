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
  AuditTemplateScope,
} from "@balebase/validators/audits";
import { useCallback, useEffect, useState } from "react";
import { api } from "./apiClient";
import {
  type AuditTemplateView,
  readAuditTemplateView,
  storeAuditTemplateView,
} from "./auditTemplateView";
import { ErrorToast } from "./ErrorToast";
import { type ErrorNotice, errorNotice } from "./errors";
import { InfiniteScroll } from "./InfiniteScroll";
import { countLabel, formatLabel } from "./labels";
import { useCursorPages } from "./useCursorPages";
import { useLoad } from "./useLoad";

export function AuditHome({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const templates = useLoad(
    useCallback(async () => (await api.audits.listTemplates()).templates, []),
    "Could not load audits.",
  );
  const [busy, setBusy] = useState(false);
  const [templateView, setTemplateView] = useState(() =>
    readAuditTemplateView(),
  );
  const [error, setError] = useState<ErrorNotice>();
  const runList = useAuditRunList();

  async function createTemplate() {
    setBusy(true);
    setError(undefined);
    try {
      const { template } =
        await api.audits.createTemplate("Untitled checklist");
      onNavigate(`/audits/templates/${template.id}`);
    } catch (cause) {
      setError(errorNotice(cause, "Could not load audits."));
      setBusy(false);
    }
  }

  async function beginAudit(templateId: string) {
    setBusy(true);
    setError(undefined);
    try {
      const { auditId } = await api.audits.start(templateId);
      onNavigate(`/audits/runs/${auditId}`);
    } catch (cause) {
      setError(errorNotice(cause, "Could not load audits."));
      setBusy(false);
    }
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
        <Button icon="download" onClick={() => onNavigate("/offline")}>
          Download forms for offline work
        </Button>
        <TemplateLibrary
          busy={busy}
          onBegin={beginAudit}
          onEdit={(id) => onNavigate(`/audits/templates/${id}`)}
          onViewChange={changeTemplateView}
          templates={templates.data}
          view={templateView}
        />
        <AuditHistory
          error={runList.error}
          loadingMore={runList.loadingMore}
          nextCursor={runList.nextCursor}
          onLoadMore={runList.loadMore}
          onOpen={(id) => onNavigate(`/audits/runs/${id}`)}
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

const templateViews: {
  icon: IconName;
  label: string;
  view: AuditTemplateView;
}[] = [
  { icon: "grid", label: "Grid", view: "grid" },
  { icon: "list", label: "List", view: "list" },
];

function TemplateLibrary({
  onViewChange,
  templates,
  view,
  ...actions
}: TemplateActions & {
  onViewChange: (view: AuditTemplateView) => void;
  templates: AuditTemplate[] | undefined;
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
        <div className="auditCollections">
          <TemplateCollection
            {...actions}
            description="Available in every organization."
            emptyMessage="No global checklists are available yet."
            emptyTitle="No global forms"
            templates={templates.filter(({ scope }) => scope === "global")}
            title="Global forms"
            view={view}
          />
          <TemplateCollection
            {...actions}
            description="Private to the active organization."
            emptyMessage="No forms have been created for this organization yet. Customize a global form or start a new checklist."
            emptyTitle="No organization forms yet"
            templates={templates.filter(
              ({ scope }) => scope === "organization",
            )}
            title="Organization forms"
            view={view}
          />
        </div>
      ) : (
        <LoadingState label="Loading checklists…" />
      )}
    </PageSection>
  );
}

function TemplateViewSwitcher({
  onChange,
  view,
}: {
  onChange: (view: AuditTemplateView) => void;
  view: AuditTemplateView;
}) {
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Checklist layout</legend>
      {templateViews.map((option) => (
        <button
          aria-pressed={view === option.view}
          key={option.view}
          onClick={() => onChange(option.view)}
          type="button"
        >
          <Icon name={option.icon} size={16} />
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function TemplateCollection({
  description,
  emptyMessage,
  emptyTitle,
  templates,
  title,
  view,
  ...actions
}: TemplateActions & {
  description: string;
  emptyMessage: string;
  emptyTitle: string;
  templates: AuditTemplate[];
  title: string;
  view: AuditTemplateView;
}) {
  return (
    <section className="auditCollection">
      <div className="auditCollectionHeading">
        <h3 className="auditCollectionTitle">
          {title}
          <Badge>{templates.length}</Badge>
        </h3>
        <p className="textSm textMuted">{description}</p>
      </div>
      {templates.length === 0 ? (
        <EmptyState compact icon="checklist" title={emptyTitle}>
          {emptyMessage}
        </EmptyState>
      ) : view === "list" ? (
        <Card className="auditTemplateList" flush>
          <ul className="rowList">
            {templates.map((template) => (
              <TemplateRow {...actions} key={template.id} template={template} />
            ))}
          </ul>
        </Card>
      ) : (
        <div className="gridAuto auditTemplateGrid">
          {templates.map((template) => (
            <TemplateCard {...actions} key={template.id} template={template} />
          ))}
        </div>
      )}
    </section>
  );
}

function TemplateCard({
  busy,
  onBegin,
  template,
  ...actions
}: TemplateActions & { template: AuditTemplate }) {
  return (
    <article className="card auditTemplateCard">
      <div className="auditTemplateBody">
        <div className="cluster">
          <Badge dot tone={templateStatusTone(template.status)}>
            {formatLabel(template.status)}
          </Badge>
          <Badge tone="info">{scopeLabel(template.scope)}</Badge>
        </div>
        <h4 className="auditTemplateName">{template.name}</h4>
        <p className="auditTemplateDescription">
          {template.description || "A custom checklist."}
        </p>
        <p className="auditTemplateMeta">
          <TemplateStats template={template} />
        </p>
      </div>
      <div className="cardFooter auditTemplateFooter">
        <div className="cluster auditTemplateActions">
          <TemplateEditButtons {...actions} template={template} />
        </div>
        <StartAuditButton
          busy={busy}
          className="auditTemplateStart"
          onBegin={onBegin}
          template={template}
        />
      </div>
    </article>
  );
}

function TemplateRow({
  busy,
  onBegin,
  template,
  ...actions
}: TemplateActions & { template: AuditTemplate }) {
  return (
    <li className="row auditTemplateRow">
      <span className="rowMain">
        <span className="rowTitle">{template.name}</span>
        <span className="rowMeta">
          {template.description || "A custom checklist."}
        </span>
      </span>
      <span className="auditTemplateRowStats">
        <Badge dot tone={templateStatusTone(template.status)}>
          {formatLabel(template.status)}
        </Badge>
        <TemplateStats template={template} />
      </span>
      <span className="rowActions auditTemplateRowActions">
        <TemplateEditButtons {...actions} template={template} />
        <StartAuditButton busy={busy} onBegin={onBegin} template={template} />
      </span>
    </li>
  );
}

export function TemplateStats({ template }: { template: AuditTemplate }) {
  return (
    <>
      <span className="cluster auditTemplateStat">
        <Icon name="checklist" size={16} />
        {countLabel(itemCount(template), "item")}
      </span>
      <span className="cluster auditTemplateStat">
        <Icon name="layers" size={16} />
        {countLabel(template.definition.sections.length, "section")}
      </span>
      <span className="auditTemplateStat mono">v{template.version}</span>
    </>
  );
}

function TemplateEditButtons({
  onEdit,
  template,
}: Pick<TemplateActions, "onEdit"> & { template: AuditTemplate }) {
  return (
    <Button icon="edit" onClick={() => onEdit(template.id)} size="sm">
      {template.scope === "global" ? "Customize" : "Edit"}
    </Button>
  );
}

function StartAuditButton({
  busy,
  className,
  onBegin,
  template,
}: Pick<TemplateActions, "busy" | "onBegin"> & {
  className?: string;
  template: AuditTemplate;
}) {
  return (
    <Button
      className={className}
      disabled={busy}
      iconEnd="arrowRight"
      onClick={() => void onBegin(template.id)}
      size="sm"
      variant="primary"
    >
      Start audit
    </Button>
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

function itemCount(template: AuditTemplate) {
  return template.definition.sections.reduce(
    (count, section) => count + section.items.length,
    0,
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

export function templateStatusTone(value: string): BadgeTone {
  if (value === "published") return "success";
  return "neutral";
}

function scopeLabel(scope: AuditTemplateScope) {
  return scope === "global" ? "Global" : "Organization";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
