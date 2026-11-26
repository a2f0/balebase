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
import type { FormTemplateSummary } from "@balebase/validators/forms";
import { discardedTemplateRetentionDays } from "@balebase/validators/rules";
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { balebase } from "../balebase";
import { FormTemplateBuilder } from "../forms/FormTemplateBuilder";
import {
  TemplateStats,
  templateStatusTone,
} from "../forms/TemplateCollections";
import { AppButtonLink } from "../shared/AppLink";
import { countLabel, formatDate, formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import {
  globalFormTemplateIdForPath,
  globalTemplatesPath,
} from "../workspace/workspacePaths";

/**
 * Root admin's home for global templates: every organization can run or copy
 * published templates; root admins control their publication here.
 */
export function AdminGlobalTemplates({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const templateId = globalFormTemplateIdForPath(pathname);
  return templateId ? (
    <FormTemplateBuilder
      id={templateId}
      key={templateId}
      manageGlobal
      onNavigate={onNavigate}
    />
  ) : (
    <GlobalFormList onNavigate={onNavigate} />
  );
}

function GlobalFormList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(
      async () => (await balebase().api.adminFormTemplates.list()).templates,
      [],
    ),
    "Could not load global templates.",
  );
  const discarded = useLoad(
    useCallback(
      async () =>
        (await balebase().api.adminFormTemplates.list("discarded")).templates,
      [],
    ),
    "Could not load discarded templates.",
  );
  const templates = loaded.data;
  const creating = useAction("Could not create the global template.");
  const restoring = useAction("Could not restore the template.");
  const busy = creating.busy || restoring.busy;
  const error = creating.error ?? restoring.error ?? loaded.error;

  async function restoreTemplate(template: FormTemplateSummary) {
    await restoring.run(
      async () =>
        (await balebase().api.adminFormTemplates.restore(template)).template,
      (restored) =>
        `“${restored.name}” restored as ${restored.status === "draft" ? "a draft" : "an unpublished template"}.`,
    );
    // Both lists change on success; a refused restore means the discarded
    // list was stale, so show the current one either way.
    await Promise.all([loaded.reload(), discarded.reload()]);
  }

  async function createTemplate() {
    await creating.run(async () => {
      const { template } =
        await balebase().api.adminFormTemplates.create("Untitled template");
      onNavigate(globalTemplatesPath(template.id));
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
            New global template
          </Button>
        }
        description={`Publish templates to share them with every organization. Unpublish templates to keep them private, or discard drafts and unpublished templates you no longer need; discarded templates can be restored for ${discardedTemplateRetentionDays} days. Form counts cover every organization.`}
        eyebrow="Root Admin"
        title="Global templates"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {restoring.notice && <Toast tone="success">{restoring.notice}</Toast>}
        <PageSection
          actions={
            templates && (
              <span className="sectionCount">
                {countLabel(templates.length, "template")}
              </span>
            )
          }
          title="Global templates"
        >
          {templates?.length ? (
            <Card className="formTemplateList" flush>
              <ul className="rowList">
                {templates.map((template) => (
                  <GlobalFormRow
                    key={template.id}
                    onNavigate={onNavigate}
                    template={template}
                  />
                ))}
              </ul>
            </Card>
          ) : templates ? (
            <EmptyState compact icon="template" title="No global templates">
              Create a global template to share it with every organization.
            </EmptyState>
          ) : (
            !error && <LoadingState label="Loading global templates…" />
          )}
        </PageSection>
        <DiscardedTemplates
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
 * Discarded templates awaiting the purge job, newest discard first. Each one can
 * be restored until it is permanently deleted.
 */
function DiscardedTemplates({
  busy,
  error,
  onRestore,
  templates,
}: {
  busy: boolean;
  error: string | undefined;
  onRestore: (template: FormTemplateSummary) => Promise<void>;
  templates: FormTemplateSummary[] | undefined;
}) {
  // A discarded template's history stays readable until the purge, so admins can
  // see who made and published it before deciding whether to restore it.
  const [historyId, setHistoryId] = useState<string>();
  const history = templates?.find(({ id }) => id === historyId);
  return (
    <PageSection
      actions={
        templates && (
          <span className="sectionCount">
            {countLabel(templates.length, "template")}
          </span>
        )
      }
      description={`Discarded templates are permanently deleted, with their versions and history, ${discardedTemplateRetentionDays} days after they are discarded. Forms started from them keep their own copies.`}
      title="Discarded templates"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {templates?.length ? (
        <Card className="formTemplateList" flush>
          <ul className="rowList">
            {templates.map((template) => (
              <li className="row formTemplateRow" key={template.id}>
                <span className="rowMain">
                  <span className="rowTitle">{template.name}</span>
                  <span className="rowMeta">
                    Discarded {formatDate(template.savedAt)} by{" "}
                    {template.savedBy.name} · Deleted after{" "}
                    {formatDate(purgeDate(template.savedAt))}
                  </span>
                </span>
                <span className="rowActions formTemplateRowActions">
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
        <EmptyState compact icon="template" title="No discarded templates">
          Discarded drafts and unpublished templates appear here until they are
          deleted.
        </EmptyState>
      ) : (
        !error && <LoadingState label="Loading discarded templates…" />
      )}
      {history && (
        <section aria-label={`History of ${history.name}`}>
          <ActivityFeed
            key={history.id}
            source={{ id: history.id, type: "global_form_template" }}
          />
        </section>
      )}
    </PageSection>
  );
}

/** When the purge job may delete a template discarded at `discardedAt`. */
function purgeDate(discardedAt: string) {
  return (
    new Date(discardedAt).getTime() +
    discardedTemplateRetentionDays * 24 * 60 * 60 * 1000
  );
}

function GlobalFormRow({
  onNavigate,
  template,
}: {
  onNavigate: (pathname: string) => void;
  template: FormTemplateSummary;
}) {
  const href = globalTemplatesPath(template.id);
  return (
    <li className="row formTemplateRow">
      <span className="rowMain">
        <span className="rowTitle">{template.name}</span>
        <span className="rowMeta">
          {template.description || "A custom template."}
        </span>
      </span>
      <span className="formTemplateRowStats">
        <Badge dot tone={templateStatusTone(template.status)}>
          {formatLabel(template.status)}
        </Badge>
        <TemplateStats formCount={template.formCount} template={template} />
      </span>
      <span className="rowActions formTemplateRowActions">
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
