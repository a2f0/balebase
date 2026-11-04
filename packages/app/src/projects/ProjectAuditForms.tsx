import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { useState } from "react";
import {
  readAuditTemplateView,
  storeAuditTemplateView,
} from "../audits/auditTemplateView";
import {
  TemplateCollections,
  TemplateViewSwitcher,
} from "../audits/TemplateCollections";
import { useDevice } from "../offline/offlineContext";
import type { OfflineAudit, OfflineWorkspace } from "../offline/offlineStore";
import { startOfflineAudit } from "../offline/offlineWork";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { auditRunPath, projectAuditPath } from "../workspace/workspacePaths";

const formCopy = {
  global: {
    description: "Published forms available in every organization.",
    emptyTitle: "No global forms on this project",
    title: "Global forms",
  },
  organization: {
    description: "This organization's published forms.",
    emptyTitle: "No organization forms on this project",
    title: "Organization forms",
  },
};

/**
 * The forms a project uses, to start audits from, and the audits this device
 * started for it. Audits start on the device whether or not it is online,
 * and each syncs once it is completed and the device is online.
 */
export function ProjectAuditForms({
  forms,
  onNavigate,
  projectId,
}: {
  forms: AuditTemplate[];
  onNavigate: (pathname: string) => void;
  projectId: string;
}) {
  const { workspace } = useDevice();
  const [view, setView] = useState(() => readAuditTemplateView());
  const action = useAction("Could not start the audit.");
  const start = (template: AuditTemplate) =>
    action.run(async () => {
      if (!workspace)
        throw new Error(
          "This device is still getting ready for audits. Stay connected and try again.",
        );
      const id = await startOfflineAudit(workspace.key, template, projectId);
      onNavigate(projectAuditPath(projectId, id));
    });
  return (
    <>
      <PageSection
        actions={
          <div className="auditTemplateToolbar">
            <span className="sectionCount">
              {countLabel(forms.length, "form")}
            </span>
            <TemplateViewSwitcher
              onChange={(next) => {
                setView(next);
                storeAuditTemplateView(next);
              }}
              view={view}
            />
          </div>
        }
        description="Audits start on this device and sync once completed, whenever it is online."
        title="Audit forms"
      >
        {action.error && <Toast tone="danger">{action.error}</Toast>}
        <TemplateCollections
          actions={(template, layout) => (
            <Button
              className={layout === "grid" ? "auditTemplateStart" : undefined}
              disabled={action.busy}
              iconEnd="arrowRight"
              onClick={() => void start(template)}
              size="sm"
              variant="primary"
            >
              Start audit
            </Button>
          )}
          copy={formCopy}
          templates={forms}
          view={view}
        />
      </PageSection>
      <DeviceAudits
        onNavigate={onNavigate}
        projectId={projectId}
        workspace={workspace}
      />
    </>
  );
}

/** The audits this device started for the project, newest first. */
export function DeviceAudits({
  onNavigate,
  projectId,
  workspace,
}: {
  onNavigate: (pathname: string) => void;
  projectId: string;
  workspace: OfflineWorkspace | undefined;
}) {
  const audits = (workspace?.audits ?? [])
    .filter((audit) => audit.projectId === projectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(audits.length, "audit")}
        </span>
      }
      description="Drafts stay here until completed. Completed audits sync when this device is online."
      title="On this device"
    >
      {audits.length && workspace ? (
        <Card flush>
          <ul className="rowList">
            {audits.map((audit) => (
              <DeviceAuditRow
                audit={audit}
                key={audit.id}
                onNavigate={onNavigate}
                workspace={workspace}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState compact icon="audits" title="No audits on this device">
          Start one from a form above.
        </EmptyState>
      )}
    </PageSection>
  );
}

function DeviceAuditRow({
  audit,
  onNavigate,
  workspace,
}: {
  audit: OfflineAudit;
  onNavigate: (pathname: string) => void;
  workspace: OfflineWorkspace;
}) {
  const state = deviceAuditState(audit, workspace);
  const open = () =>
    onNavigate(
      state.synced
        ? auditRunPath(audit.id)
        : projectAuditPath(audit.projectId, audit.id),
    );
  return (
    <li className="row">
      <span className="rowMain">
        <span className="rowTitle truncate">{audit.template.name}</span>
        <span className="rowMeta truncate">
          v{audit.template.version} · Started {formatDate(audit.startedAt)}
          {state.error ? ` · ${state.error}` : ""}
        </span>
      </span>
      <Badge dot tone={state.tone}>
        {state.label}
      </Badge>
      <Button onClick={open} size="sm">
        {state.synced ? "Open audit" : audit.queued ? "View" : "Continue"}
      </Button>
    </li>
  );
}

/** Where a device audit is: a draft, waiting to sync, held back, or synced. */
function deviceAuditState(
  audit: OfflineAudit,
  workspace: OfflineWorkspace,
): { error?: string; label: string; synced: boolean; tone: BadgeTone } {
  if (!audit.queued) return { label: "Draft", synced: false, tone: "neutral" };
  const job = workspace.jobs.find((entry) => entry.id === audit.id);
  if (job?.status === "synced")
    return { label: "Synced", synced: true, tone: "success" };
  if (job?.status === "blocked")
    return {
      ...(job.error ? { error: job.error } : {}),
      label: "Not synced",
      synced: false,
      tone: "danger",
    };
  return {
    ...(job?.error ? { error: job.error } : {}),
    label: "Waiting to sync",
    synced: false,
    tone: "warning",
  };
}

/**
 * Audits this device started for projects it no longer lists: one deleted,
 * or that the person left, since. Their work still finishes and syncs from
 * here. Nothing when there are none.
 */
export function OtherDeviceAudits({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  if (!workspace) return null;
  const listed = new Set(workspace.projects.map((project) => project.id));
  const audits = workspace.audits
    .filter(
      (audit) =>
        !listed.has(audit.projectId) &&
        !deviceAuditState(audit, workspace).synced,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!audits.length) return null;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(audits.length, "audit")}
        </span>
      }
      description="Started on this device for projects you are no longer on, or that were deleted. Finish them here; completed audits still sync."
      title="Other audits on this device"
    >
      <Card flush>
        <ul className="rowList">
          {audits.map((audit) => (
            <DeviceAuditRow
              audit={audit}
              key={audit.id}
              onNavigate={onNavigate}
              workspace={workspace}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
