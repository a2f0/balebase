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
import { auditWrites, unsyncedAnswers } from "../offline/offlineAuditState";
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
 * and sync once their progress is saved or they are completed, whenever the
 * device is online.
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
        description="Audits start on this device. Once you save a draft's progress, its answers sync both ways whenever this device is online."
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
      description="Drafts stay on this device until you save their progress, raise an issue, or complete them. Shared audits sync both ways when this device is online."
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
        {state.synced
          ? "Open audit"
          : audit.status === "completed"
            ? "View"
            : "Continue"}
      </Button>
    </li>
  );
}

/**
 * Where a device audit is: a draft; in progress, with changes waiting to
 * sync or up to date; completed and waiting to sync; held back; or synced.
 * A completed audit is synced only once its issues and their photos are
 * too, so the device keeps showing it while any of its work is still here.
 */
function deviceAuditState(
  audit: OfflineAudit,
  workspace: OfflineWorkspace,
): { error?: string; label: string; synced: boolean; tone: BadgeTone } {
  if (audit.status === "draft")
    return { label: "Draft", synced: false, tone: "neutral" };
  const writes = auditWrites(workspace.jobs, audit.id);
  const left = unsyncedWork(audit, workspace, writes);
  const error = left.find((job) => job.error)?.error;
  const reason = error ? { error } : {};
  if (left.some((job) => job.status === "blocked"))
    return { ...reason, label: "Not synced", synced: false, tone: "danger" };
  if (audit.status === "completed")
    return left.length
      ? {
          ...reason,
          label: writes.some((job) => job.status !== "synced")
            ? "Waiting to sync"
            : "Issues waiting to sync",
          synced: false,
          tone: "warning",
        }
      : { label: "Synced", synced: true, tone: "success" };
  return left.length || unsyncedAnswers(audit)
    ? {
        ...reason,
        label: "Changes waiting to sync",
        synced: false,
        tone: "warning",
      }
    : { label: "Up to date", synced: false, tone: "info" };
}

/** The audit's writes, issues, and photos still to sync. */
function unsyncedWork(
  audit: OfflineAudit,
  workspace: OfflineWorkspace,
  writes: OfflineWorkspace["jobs"],
) {
  const ids = new Set(writes.map((job) => job.id));
  for (const issue of workspace.issues)
    if (issue.operation.auditId === audit.id) {
      ids.add(issue.operation.id);
      for (const image of issue.images) ids.add(image.id);
    }
  return workspace.jobs.filter(
    (job) => ids.has(job.id) && job.status !== "synced",
  );
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
