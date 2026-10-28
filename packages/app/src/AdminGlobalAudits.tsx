import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { useEffect, useState } from "react";
import { TemplateStats, templateStatusTone } from "./AuditHome";
import { AuditTemplateBuilder } from "./AuditTemplateBuilder";
import { api } from "./apiClient";
import { errorMessage } from "./errors";
import { countLabel, formatLabel } from "./labels";
import {
  globalAuditsPath,
  globalAuditTemplateIdForPath,
} from "./organizationState";
import { handleNavigation } from "./workspacePaths";

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
  const [templates, setTemplates] = useState<AuditTemplate[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.adminAuditTemplates
      .list()
      .then(({ templates }) => setTemplates(templates))
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Could not load global forms.")),
      );
  }, []);

  async function createTemplate() {
    setBusy(true);
    setError(undefined);
    try {
      const { template } =
        await api.adminAuditTemplates.create("Untitled checklist");
      onNavigate(globalAuditsPath(template.id));
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the global form."));
      setBusy(false);
    }
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
        description="Publish checklists to share them with every organization. Unpublish forms to keep them private, or discard drafts you no longer need."
        eyebrow="Root Admin"
        title="Global Audits"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
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
      </PageBody>
    </Page>
  );
}

function GlobalAuditRow({
  onNavigate,
  template,
}: {
  onNavigate: (pathname: string) => void;
  template: AuditTemplate;
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
        <TemplateStats template={template} />
      </span>
      <span className="rowActions auditTemplateRowActions">
        <ButtonLink
          href={href}
          icon="edit"
          onClick={(event) => handleNavigation(event, href, onNavigate)}
          size="sm"
        >
          Manage
        </ButtonLink>
      </span>
    </li>
  );
}
