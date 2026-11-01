import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { AuditTemplateSummary } from "@balebase/validators/audits";
import { discardedTemplateRetentionDays } from "@balebase/validators/rules";
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { TemplateStats, templateStatusTone } from "../audits/AuditHome";
import { AuditTemplateBuilder } from "../audits/AuditTemplateBuilder";
import { AppButtonLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { countLabel, formatDate, formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import {
  globalAuditsPath,
  globalAuditTemplateIdForPath,
} from "../workspace/workspacePaths";

/**
 * Root admin's home for global forms: every organization can run or copy
 * published forms; root admins control their publication here.
 */
export function AdminGlobalAudits({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const templateId = globalAuditTemplateIdForPath(pathname);
  return templateId ? (
    <AuditTemplateBuilder
      id={templateId}
      key={templateId}
      manageGlobal
      onNavigate={onNavigate}
    />
  ) : (
    <GlobalAuditList onNavigate={onNavigate} />
  );
}

function GlobalAuditList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(
      async () => (await api.adminAuditTemplates.list()).templates,
      [],
    ),
    "Could not load global forms.",
  );
  const discarded = useLoad(
    useCallback(
      async () => (await api.adminAuditTemplates.list("discarded")).templates,
      [],
    ),
    "Could not load discarded forms.",
  );
  const templates = loaded.data;
  const creating = useAction("Could not create the global form.");
  const restoring = useAction("Could not restore the form.");
  const busy = creating.busy || restoring.busy;
  const error = creating.error ?? restoring.error ?? loaded.error;

  async function restoreTemplate(template: AuditTemplateSummary) {
    await restoring.run(
      async () => (await api.adminAuditTemplates.restore(template)).template,
      (restored) =>
        `“${restored.name}” restored as ${restored.status === "draft" ? "a draft" : "an unpublished form"}.`,
    );
    // Both lists change on success; a refused restore means the discarded
    // list was stale, so show the current one either way.
    await Promise.all([loaded.reload(), discarded.reload()]);
  }

  async function createTemplate() {
    await creating.run(async () => {
      const { template } =
        await api.adminAuditTemplates.create("Untitled checklist");
      onNavigate(globalAuditsPath(template.id));
    });
  }

  return (
    <Page>
      <PageHeader
        actions={
          <Button
            busy={busy}
            icon="add"
            onClick={() => void createTemplate()}
            variant="primary"
          >
            New global checklist
          </Button>
        }
        description={`Publish checklists to share them with every organization. Unpublish forms to keep them private, or discard drafts and unpublished forms you no longer need; discarded forms can be restored for ${discardedTemplateRetentionDays} days. Audit counts cover every organization.`}
        eyebrow="Root Admin"
        title="Global Audits"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {restoring.notice && <Toast tone="success">{restoring.notice}</Toast>}
        <PageSection
          actions={
            templates && (
              <span className="sectionCount">
                {countLabel(templates.length, "form")}
              </span>
            )
          }
          title="Global forms"
        >
          {templates?.length ? (
            <Card className="auditTemplateList" flush>
              <ul className="rowList">
                {templates.map((template) => (
                  <GlobalAuditRow
                    key={template.id}
                    onNavigate={onNavigate}
                    template={template}
                  />
                ))}
              </ul>
            </Card>
          ) : templates ? (
            <EmptyState compact icon="checklist" title="No global forms">
              Create a global checklist to share it with every organization.
            </EmptyState>
          ) : (
            !error && <LoadingState label="Loading global forms…" />
          )}
        </PageSection>
        <DiscardedForms
          busy={busy}
          error={discarded.error}
          onRestore={restoreTemplate}
          templates={discarded.data}
        />
      </PageBody>
    </Page>
  );
}

/**
 * Discarded forms awaiting the purge job, newest discard first. Each one can
 * be restored until it is permanently deleted.
 */
function DiscardedForms({
  busy,
  error,
  onRestore,
  templates,
}: {
  busy: boolean;
  error: string | undefined;
  onRestore: (template: AuditTemplateSummary) => Promise<void>;
  templates: AuditTemplateSummary[] | undefined;
}) {
  // A discarded form's history stays readable until the purge, so admins can
  // see who made and published it before deciding whether to restore it.
  const [historyId, setHistoryId] = useState<string>();
  const history = templates?.find(({ id }) => id === historyId);
  return (
    <PageSection
      actions={
        templates && (
          <span className="sectionCount">
            {countLabel(templates.length, "form")}
          </span>
        )
      }
      description={`Discarded forms are permanently deleted, with their versions and history, ${discardedTemplateRetentionDays} days after they are discarded. Audits started from them keep their own copies.`}
      title="Discarded forms"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {templates?.length ? (
        <Card className="auditTemplateList" flush>
          <ul className="rowList">
            {templates.map((template) => (
              <li className="row auditTemplateRow" key={template.id}>
                <span className="rowMain">
                  <span className="rowTitle">{template.name}</span>
                  <span className="rowMeta">
                    Discarded {formatDate(template.savedAt)} by{" "}
                    {template.savedBy.name} · Deleted after{" "}
                    {formatDate(purgeDate(template.savedAt))}
                  </span>
                </span>
                <span className="rowActions auditTemplateRowActions">
                  <Button
                    aria-pressed={historyId === template.id}
                    icon="list"
                    onClick={() =>
                      setHistoryId((open) =>
                        open === template.id ? undefined : template.id,
                      )
                    }
                    size="sm"
                  >
                    History
                  </Button>
                  <Button
                    disabled={busy}
                    icon="restore"
                    onClick={() => void onRestore(template)}
                    size="sm"
                  >
                    Restore
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : templates ? (
        <EmptyState compact icon="checklist" title="No discarded forms">
          Discarded drafts and unpublished forms appear here until they are
          deleted.
        </EmptyState>
      ) : (
        !error && <LoadingState label="Loading discarded forms…" />
      )}
      {history && (
        <section aria-label={`History of ${history.name}`}>
          <ActivityFeed
            key={history.id}
            source={{ id: history.id, type: "global_audit_template" }}
          />
        </section>
      )}
    </PageSection>
  );
}

/** When the purge job may delete a form discarded at `discardedAt`. */
function purgeDate(discardedAt: string) {
  return (
    new Date(discardedAt).getTime() +
    discardedTemplateRetentionDays * 24 * 60 * 60 * 1000
  );
}

function GlobalAuditRow({
  onNavigate,
  template,
}: {
  onNavigate: (pathname: string) => void;
  template: AuditTemplateSummary;
}) {
  const href = globalAuditsPath(template.id);
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
        <TemplateStats auditCount={template.auditCount} template={template} />
      </span>
      <span className="rowActions auditTemplateRowActions">
        <AppButtonLink
          href={href}
          icon="edit"
          onNavigate={onNavigate}
          size="sm"
        >
          Manage
        </AppButtonLink>
      </span>
    </li>
  );
}
