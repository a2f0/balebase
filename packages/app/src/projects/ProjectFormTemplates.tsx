import {
  formWrites,
  type OfflineForm,
  type OfflineWorkspace,
  unsyncedAnswers,
} from "@balebase/client-sdk";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { FormTemplate } from "@balebase/validators/forms";
import { useState } from "react";
import { balebase } from "../balebase";
import {
  readFormTemplateView,
  storeFormTemplateView,
} from "../forms/formTemplateView";
import {
  TemplateCollections,
  TemplateViewSwitcher,
} from "../forms/TemplateCollections";
import { useDevice } from "../offline/offlineContext";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { formRunPath, projectFormPath } from "../workspace/workspacePaths";

const templateCopy = {
  global: {
    description: "Published templates available in every organization.",
    emptyTitle: "No global templates on this project",
    title: "Global templates",
  },
  organization: {
    description: "This organization's published templates.",
    emptyTitle: "No organization templates on this project",
    title: "Organization templates",
  },
};

/**
 * The templates a project uses, to start forms from, and the forms this device
 * started for it. Forms start on the device whether or not it is online,
 * and sync once their progress is saved or they are completed, whenever the
 * device is online.
 */
export function ProjectFormTemplates({
  templates,
  onNavigate,
  projectId,
}: {
  templates: FormTemplate[];
  onNavigate: (pathname: string) => void;
  projectId: string;
}) {
  const { workspace } = useDevice();
  const [view, setView] = useState(() => readFormTemplateView());
  const action = useAction("Could not start the form.");
  const start = (template: FormTemplate) =>
    action.run(async () => {
      if (!workspace)
        throw new Error(
          "This device is still getting ready for forms. Stay connected and try again.",
        );
      const id = await balebase().offline.startForm(
        workspace.key,
        template,
        projectId,
      );
      onNavigate(projectFormPath(projectId, id));
    });
  return (
    <>
      <PageSection
        actions={
          <div className="formTemplateToolbar">
            <span className="sectionCount">
              {countLabel(templates.length, "template")}
            </span>
            <TemplateViewSwitcher
              onChange={(next) => {
                setView(next);
                storeFormTemplateView(next);
              }}
              view={view}
            />
          </div>
        }
        description="Forms start on this device. Once you save a draft's progress, its answers sync both ways whenever this device is online."
        title="Form templates"
      >
        {action.error && <Toast tone="danger">{action.error}</Toast>}
        <TemplateCollections
          actions={(template, layout) => (
            <Button
              className={layout === "grid" ? "formTemplateStart" : undefined}
              disabled={action.busy}
              iconEnd="arrowRight"
              onClick={() => void start(template)}
              size="sm"
              variant="primary"
            >
              Start form
            </Button>
          )}
          copy={templateCopy}
          templates={templates}
          view={view}
        />
      </PageSection>
      <DeviceForms
        onNavigate={onNavigate}
        projectId={projectId}
        workspace={workspace}
      />
    </>
  );
}

/** The forms this device started for the project, newest first. */
export function DeviceForms({
  onNavigate,
  projectId,
  workspace,
}: {
  onNavigate: (pathname: string) => void;
  projectId: string;
  workspace: OfflineWorkspace | undefined;
}) {
  const forms = (workspace?.forms ?? [])
    .filter((form) => form.projectId === projectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <PageSection
      actions={
        <span className="sectionCount">{countLabel(forms.length, "form")}</span>
      }
      description="Drafts stay on this device until you save their progress, raise an issue, or complete them. Shared forms sync both ways when this device is online."
      title="On this device"
    >
      {forms.length && workspace ? (
        <Card flush>
          <ul className="rowList">
            {forms.map((form) => (
              <DeviceFormRow
                form={form}
                key={form.id}
                onNavigate={onNavigate}
                workspace={workspace}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState compact icon="forms" title="No forms on this device">
          Start one from a template above.
        </EmptyState>
      )}
    </PageSection>
  );
}

function DeviceFormRow({
  form,
  onNavigate,
  workspace,
}: {
  form: OfflineForm;
  onNavigate: (pathname: string) => void;
  workspace: OfflineWorkspace;
}) {
  const state = deviceFormState(form, workspace);
  const open = () =>
    onNavigate(
      state.synced
        ? formRunPath(form.id)
        : projectFormPath(form.projectId, form.id),
    );
  return (
    <li className="row">
      <span className="rowMain">
        <span className="rowTitle truncate">{form.template.name}</span>
        <span className="rowMeta truncate">
          v{form.template.version} · Started {formatDate(form.startedAt)}
          {state.error ? ` · ${state.error}` : ""}
        </span>
      </span>
      <Badge dot tone={state.tone}>
        {state.label}
      </Badge>
      <Button onClick={open} size="sm">
        {state.synced
          ? "Open form"
          : form.status === "completed"
            ? "View"
            : "Continue"}
      </Button>
    </li>
  );
}

/**
 * Where a device form is: a draft; in progress, with changes waiting to
 * sync or up to date; completed and waiting to sync; held back; or synced.
 * A completed form is synced only once its issues and their photos are
 * too, so the device keeps showing it while any of its work is still here.
 */
function deviceFormState(
  form: OfflineForm,
  workspace: OfflineWorkspace,
): { error?: string; label: string; synced: boolean; tone: BadgeTone } {
  if (form.status === "draft")
    return { label: "Draft", synced: false, tone: "neutral" };
  const writes = formWrites(workspace.jobs, form.id);
  const left = unsyncedWork(form, workspace, writes);
  const error = left.find((job) => job.error)?.error;
  const reason = error ? { error } : {};
  if (left.some((job) => job.status === "blocked"))
    return { ...reason, label: "Not synced", synced: false, tone: "danger" };
  if (form.status === "completed")
    return left.length || unsyncedAnswers(form)
      ? {
          ...reason,
          label:
            unsyncedAnswers(form) ||
            writes.some((job) => job.status !== "synced")
              ? "Waiting to sync"
              : "Issues waiting to sync",
          synced: false,
          tone: "warning",
        }
      : { label: "Synced", synced: true, tone: "success" };
  return left.length || unsyncedAnswers(form)
    ? {
        ...reason,
        label: "Changes waiting to sync",
        synced: false,
        tone: "warning",
      }
    : { label: "Up to date", synced: false, tone: "info" };
}

/** The form's writes, issues, and photos still to sync. */
function unsyncedWork(
  form: OfflineForm,
  workspace: OfflineWorkspace,
  writes: OfflineWorkspace["jobs"],
) {
  const ids = new Set(writes.map((job) => job.id));
  for (const issue of workspace.issues)
    if (issue.operation.formId === form.id) {
      ids.add(issue.operation.id);
      for (const image of issue.images) ids.add(image.id);
    }
  return workspace.jobs.filter(
    (job) => ids.has(job.id) && job.status !== "synced",
  );
}

/**
 * Forms this device started for projects it no longer lists: one deleted,
 * or that the person left, since. Their work still finishes and syncs from
 * here. Nothing when there are none.
 */
export function OtherDeviceForms({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  if (!workspace) return null;
  const listed = new Set(workspace.projects.map((project) => project.id));
  const forms = workspace.forms
    .filter(
      (form) =>
        !listed.has(form.projectId) && !deviceFormState(form, workspace).synced,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!forms.length) return null;
  return (
    <PageSection
      actions={
        <span className="sectionCount">{countLabel(forms.length, "form")}</span>
      }
      description="Started on this device for projects you are no longer on, or that were deleted. Finish them here; completed forms still sync."
      title="Other forms on this device"
    >
      <Card flush>
        <ul className="rowList">
          {forms.map((form) => (
            <DeviceFormRow
              form={form}
              key={form.id}
              onNavigate={onNavigate}
              workspace={workspace}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
