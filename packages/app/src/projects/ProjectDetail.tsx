import {
  Button,
  Card,
  confirmDialog,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import type { Person } from "@balebase/validators/fields";
import type {
  ProjectForm as Form,
  Project,
} from "@balebase/validators/projects";
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { projectPath } from "../workspace/workspacePaths";
import { ProjectForm } from "./ProjectForm";

function useProjectDetail(id: string, onNavigate: (pathname: string) => void) {
  const loaded = useLoad(
    useCallback(() => api.projects.get(id), [id]),
    "Could not load the project.",
  );
  const { reload, setData } = loaded;
  const action = useAction("Could not update the project.");
  // The project as it was when editing began: later refreshes, such as a
  // member change, must not move the edit onto a revision it never showed.
  const [editing, setEditing] = useState<Project>();

  const change = (work: () => Promise<Project>, message?: string) =>
    action.run(async () => {
      const project = await work();
      setData((current) => (current ? { ...current, project } : current));
    }, message);

  async function saveEdit(
    base: Project,
    input: { description: string; name: string },
  ) {
    const saved = await change(
      () => api.projects.update(id, editedFields(base, input)),
      "Project updated.",
    );
    // A refused edit keeps the editor's text; reloading lets the next edit
    // start from the latest revision.
    if (saved) setEditing(undefined);
    else void reload();
    return saved;
  }

  async function remove(project: Project) {
    const confirmed = await confirmDialog({
      confirmLabel: "Delete project",
      message:
        "Members keep the forms already on their devices. The project's history stays in Activity.",
      title: `Delete ${project.name}?`,
      tone: "danger",
    });
    if (!confirmed) return;
    await action.run(async () => {
      await api.projects.delete(id);
      onNavigate(projectPath());
    });
  }

  return {
    busy: action.busy,
    change,
    detail: loaded.data,
    editing,
    error: action.error ?? loaded.error,
    notice: action.notice,
    remove,
    saveEdit,
    setEditing,
  };
}

export function ProjectDetailPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const {
    busy,
    change,
    detail,
    editing,
    error,
    notice,
    remove,
    saveEdit,
    setEditing,
  } = useProjectDetail(id, onNavigate);
  const project = detail?.project;
  const canEdit = Boolean(detail?.canManage && project && !editing);
  let title = "Loading…";
  if (project) title = project.name;
  else if (error) title = "Project unavailable";
  return (
    <Page>
      <PageHeader
        actions={
          canEdit &&
          project && (
            <>
              <Button
                disabled={busy}
                icon="edit"
                onClick={() => setEditing(project)}
              >
                Edit
              </Button>
              <Button
                disabled={busy}
                icon="trash"
                onClick={() => void remove(project)}
                variant="danger"
              >
                Delete
              </Button>
            </>
          )
        }
        back={
          <Button
            icon="arrowLeft"
            onClick={() => onNavigate(projectPath())}
            size="sm"
            variant="ghost"
          >
            Projects
          </Button>
        }
        description={project?.description || undefined}
        eyebrow="Project"
        title={title}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!detail || !project ? (
          !error && <LoadingState label="Loading project…" />
        ) : (
          <>
            {editing && (
              <ProjectForm
                initial={editing}
                onCancel={() => setEditing(undefined)}
                onSave={(input) => saveEdit(editing, input)}
              />
            )}
            <ProjectMembers
              busy={busy}
              canManage={detail.canManage}
              directory={detail.directory}
              members={project.members}
              onAdd={(userId) =>
                void change(() => api.projects.addMember(id, userId))
              }
              onRemove={(userId) =>
                void change(() => api.projects.removeMember(id, userId))
              }
            />
            <ProjectForms
              available={detail.availableForms}
              busy={busy}
              canManage={detail.canManage}
              enabled={project.forms}
              onToggle={(templateId, on) =>
                void change(() => api.projects.setForm(id, templateId, on))
              }
            />
            <ActivityFeed
              refreshKey={project}
              source={{ id, type: "project" }}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ProjectMembers({
  busy,
  canManage,
  directory,
  members,
  onAdd,
  onRemove,
}: {
  busy: boolean;
  canManage: boolean;
  directory: Person[];
  members: Person[];
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const candidates = directory.filter(
    (person) => !members.some((member) => member.id === person.id),
  );
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(members.length, "member")}
        </span>
      }
      description="Signing in downloads the project's audit forms to each member's device for offline work."
      title="Members"
    >
      {canManage && candidates.length > 0 && (
        <div className="cluster">
          <Select
            aria-label="Add a member"
            className="inputSm"
            onChange={(event) => setSelected(event.target.value)}
            value={selected}
          >
            <option value="">Choose a person…</option>
            {candidates.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name || person.email}
              </option>
            ))}
          </Select>
          <Button
            disabled={busy || !selected}
            icon="userAdd"
            onClick={() => {
              onAdd(selected);
              setSelected("");
            }}
            size="sm"
          >
            Add member
          </Button>
        </div>
      )}
      {members.length ? (
        <Card flush>
          <ul className="rowList">
            {members.map((member) => (
              <li className="row" key={member.id}>
                <span className="rowMain">
                  <span className="rowTitle truncate">
                    {member.name || member.email}
                  </span>
                  <span className="rowMeta truncate">{member.email}</span>
                </span>
                {canManage && (
                  <Button
                    aria-label={`Remove ${member.name || member.email}`}
                    disabled={busy}
                    onClick={() => onRemove(member.id)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState compact icon="userAdd" title="No members yet" />
      )}
    </PageSection>
  );
}

function ProjectForms({
  available,
  busy,
  canManage,
  enabled,
  onToggle,
}: {
  available: Form[];
  busy: boolean;
  canManage: boolean;
  enabled: Form[];
  onToggle: (templateId: string, on: boolean) => void;
}) {
  const forms = canManage ? available : enabled;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(enabled.length, "form")} on
        </span>
      }
      description="Turn on the audit forms this project uses."
      title="Audit forms"
    >
      {forms.length ? (
        <Card>
          <div className="stack">
            {forms.map((form) => {
              const on = enabled.some((entry) => entry.id === form.id);
              const label = `${form.name} · v${form.version}${form.scope === "global" ? " · Global" : ""}`;
              return canManage ? (
                <label className="check" key={form.id}>
                  <input
                    checked={on}
                    disabled={busy}
                    onChange={(event) =>
                      onToggle(form.id, event.target.checked)
                    }
                    type="checkbox"
                  />
                  {label}
                </label>
              ) : (
                <p key={form.id}>{label}</p>
              );
            })}
          </div>
        </Card>
      ) : (
        <EmptyState compact icon="audits" title="No audit forms turned on" />
      )}
    </PageSection>
  );
}

/**
 * Only the fields this editor changed, from the revision it loaded, so a
 * concurrent edit is refused rather than overwritten.
 */
function editedFields(
  project: Project,
  input: { description: string; name: string },
) {
  return {
    expectedRevision: project.revision,
    ...(input.name === project.name ? {} : { name: input.name }),
    ...(input.description === project.description
      ? {}
      : { description: input.description }),
  };
}
