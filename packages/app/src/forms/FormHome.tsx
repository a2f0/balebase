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
  FormRunView,
  FormSummary,
  FormTemplateSummary,
} from "@balebase/validators/forms";
import { useCallback, useEffect, useState } from "react";
import { ErrorToast } from "../billing/ErrorToast";
import { api } from "../shared/apiClient";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useCursorPages } from "../shared/useCursorPages";
import { useLoad } from "../shared/useLoad";
import { formRunPath, formTemplatePath } from "../workspace/workspacePaths";
import {
  type FormTemplateView,
  readFormTemplateView,
  storeFormTemplateView,
} from "./formTemplateView";
import {
  TemplateCollections,
  TemplateViewSwitcher,
} from "./TemplateCollections";

export function FormHome({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const templates = useLoad(
    useCallback(async () => (await api.forms.listTemplates()).templates, []),
    "Could not load forms.",
  );
  const creating = useAction("Could not create the template.");
  const [templateView, setTemplateView] = useState(() =>
    readFormTemplateView(),
  );
  const runList = useFormRunList();

  async function createTemplate() {
    await creating.run(async () => {
      const { template } = await api.forms.createTemplate("Untitled template");
      onNavigate(formTemplatePath(template.id));
    });
  }

  function changeTemplateView(view: FormTemplateView) {
    setTemplateView(view);
    storeFormTemplateView(view);
  }

  return (
    <Page>
      <FormHomeHeader busy={creating.busy} onCreate={createTemplate} />
      <PageBody>
        <ErrorToast error={creating.failure} onNavigate={onNavigate} />
        {templates.error && <Toast tone="danger">{templates.error}</Toast>}
        <TemplateLibrary
          onAssign={(id) => onNavigate(formTemplatePath(id, "projects"))}
          onEdit={(id) => onNavigate(formTemplatePath(id))}
          onViewChange={changeTemplateView}
          templates={templates.data}
          view={templateView}
        />
        <FormHistory
          error={runList.error}
          loadingMore={runList.loadingMore}
          nextCursor={runList.nextCursor}
          onLoadMore={runList.loadMore}
          onOpen={(id) => onNavigate(formRunPath(id))}
          onViewChange={runList.changeView}
          runs={runList.items}
          view={runList.view}
        />
      </PageBody>
    </Page>
  );
}

/**
 * Active or deleted form runs, paged. `?view=deleted` opens the deleted list
 * once (Back from a discarded form) and then leaves the address.
 */
function useFormRunList() {
  const [view, setView] = useState<FormRunView>(() =>
    new URLSearchParams(window.location.search).get("view") === "deleted"
      ? "deleted"
      : "active",
  );

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", "/forms");
    }
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await api.forms.listRuns(cursor, view);
      return { items: page.forms, nextCursor: page.nextCursor };
    },
    [view],
  );
  return {
    ...useCursorPages(fetchPage, "Could not load forms."),
    changeView: setView,
    view,
  };
}

function FormHomeHeader({
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
          New organization template
        </Button>
      }
      description="Curate shared and organization templates, and review every form. Forms are started from a project."
      eyebrow="Inspections & compliance"
      title="Forms"
    />
  );
}

interface TemplateActions {
  onAssign: (id: string) => void;
  onEdit: (id: string) => void;
}

const libraryCopy = {
  global: {
    description: "Available in every organization.",
    emptyMessage: "No global templates are available yet.",
    emptyTitle: "No global templates",
    title: "Global templates",
  },
  organization: {
    description: "Private to the active organization.",
    emptyMessage:
      "No templates have been created for this organization yet. Customize a global template or start a new one.",
    emptyTitle: "No organization templates yet",
    title: "Organization templates",
  },
};

function TemplateLibrary({
  onAssign,
  onEdit,
  onViewChange,
  templates,
  view,
}: TemplateActions & {
  onViewChange: (view: FormTemplateView) => void;
  templates: FormTemplateSummary[] | undefined;
  view: FormTemplateView;
}) {
  return (
    <PageSection
      actions={
        <div className="formTemplateToolbar">
          {templates && (
            <span className="sectionCount">
              {countLabel(templates.length, "template")}
            </span>
          )}
          <TemplateViewSwitcher onChange={onViewChange} view={view} />
        </div>
      }
      title="Templates"
    >
      {templates ? (
        <TemplateCollections
          copy={libraryCopy}
          menu={(template) => ({
            items: [
              {
                icon: "layers",
                id: "assign-projects",
                label: "Assign projects",
                onSelect: () => onAssign(template.id),
              },
              {
                icon: "edit",
                id: "customize",
                label: template.scope === "global" ? "Customize" : "Edit",
                onSelect: () => onEdit(template.id),
              },
            ],
            label: `Actions for ${template.name}`,
          })}
          templates={templates}
          view={view}
        />
      ) : (
        <LoadingState label="Loading templates…" />
      )}
    </PageSection>
  );
}

const runViews: { icon: IconName; label: string; view: FormRunView }[] = [
  { icon: "forms", label: "Active", view: "active" },
  { icon: "trash", label: "Deleted", view: "deleted" },
];

function FormHistory({
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
  onViewChange: (view: FormRunView) => void;
  runs: FormSummary[] | undefined;
  view: FormRunView;
}) {
  const hasMore = Boolean(nextCursor);
  return (
    <PageSection
      actions={
        <div className="formRunToolbar">
          {runs && (
            <span className="sectionCount">
              {runs.length}
              {hasMore ? "+" : ""}{" "}
              {runs.length === 1 && !hasMore ? "form" : "forms"}
            </span>
          )}
          <nav aria-label="Form lists" className="segmented">
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
      title={view === "deleted" ? "Deleted forms" : "Recent forms"}
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {runs?.length ? (
        <Card
          className="formRunCard"
          flush
          footer={
            nextCursor && (
              <InfiniteScroll
                autoLoad={!error}
                busy={loadingMore}
                cursor={nextCursor}
                onLoadMore={onLoadMore}
              >
                Load more forms
              </InfiniteScroll>
            )
          }
        >
          <div className="rowList">
            {runs.map((run) => (
              <FormRunRow key={run.id} onOpen={onOpen} run={run} />
            ))}
          </div>
        </Card>
      ) : runs && view === "deleted" ? (
        <EmptyState compact icon="trash" title="No deleted forms">
          Discarded forms will appear here.
        </EmptyState>
      ) : runs ? (
        <EmptyState compact icon="forms" title="No forms yet">
          Start one from a project's Forms tab.
        </EmptyState>
      ) : (
        !error && <LoadingState label="Loading forms…" />
      )}
    </PageSection>
  );
}

function FormRunRow({
  onOpen,
  run,
}: {
  onOpen: (id: string) => void;
  run: FormSummary;
}) {
  return (
    <button
      className="row formRunRow"
      onClick={() => onOpen(run.id)}
      type="button"
    >
      <span className="rowMain">
        <span className="rowTitle">{run.templateName}</span>
        <span className="rowMeta">
          {run.project.name}
          {run.project.deleted ? " (deleted project)" : ""} ·{" "}
          {run.templateVersion ? `v${run.templateVersion} · ` : ""}
          {run.deletedAt
            ? `Discarded ${formatDate(run.deletedAt)}${run.deletedBy ? ` by ${run.deletedBy.name}` : ""}`
            : `${formatDate(run.updatedAt)} · Started by ${run.createdBy.name}`}
        </span>
      </span>
      <span className="formRunStats">
        <Badge dot tone={runTone(run)}>
          {status(run)}
        </Badge>
        <span className="formRunStat">
          <Icon name="check" size={16} />
          {run.responseCount} answered
        </span>
        <span className="formRunStat">
          <Icon name="issues" size={16} />
          {countLabel(run.issueCount, "issue")}
        </span>
      </span>
      <Icon className="formRunArrow" name="arrowRight" />
    </button>
  );
}

function status(run: FormSummary) {
  if (run.deletedAt) return "Discarded";
  return run.status === "completed" ? "Completed" : "In progress";
}

function runTone(run: FormSummary): BadgeTone {
  if (run.deletedAt) return "danger";
  return run.status === "completed" ? "success" : "warning";
}
