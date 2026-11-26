import {
  Button,
  Card,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Select,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type { Person } from "@balebase/validators/fields";
import type {
  Project,
  ProjectTemplate as Template,
} from "@balebase/validators/projects";
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
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
import { ListRow } from "../shared/ListRow";
import { countLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { projectPath } from "../workspace/workspacePaths";
import { DeviceProjects, unreachableNotice } from "./DeviceProjects";
import { ProjectForm } from "./ProjectForm";
import { ProjectFormTemplates } from "./ProjectFormTemplates";
import { confirmProjectDeletion, editedFields } from "./projectChanges";

function useProjectDetail(id: string, onNavigate: (pathname: string) => void) {
  const loaded = useLoad(
    useCallback(() => balebase().api.projects.get(id), [id]),
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
      () => balebase().api.projects.update(id, editedFields(base, input)),
      "Project updated.",
    );
    // A refused edit keeps the editor's text; reloading lets the next edit
    // start from the latest revision.
    if (saved) setEditing(undefined);
    else void reload();
    return saved;
  }

  async function remove(project: Project) {
    if (!(await confirmProjectDeletion(project))) return;
    await action.run(async () => {
      await balebase().api.projects.delete(id);
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
  const sections = useProjectSections();
  const { workspace } = useDevice();
  // As on the list: an unreachable API leaves the device's copy to work from.
  if (!detail && error && workspace?.projects.some((entry) => entry.id === id))
    return (
      <DeviceProjects
        notice={unreachableNotice}
        onNavigate={onNavigate}
        pathname={projectPath(id)}
      />
    );
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
        tabs={project && sections.tabs}
        tabsKind="panels"
        tabsLabel="Project sections"
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
            <ProjectSections
              busy={busy}
              change={change}
              detail={detail}
              id={id}
              onNavigate={onNavigate}
              panel={sections.panel}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

/**
 * A project's members, the templates to start forms from, which templates it uses,
 * and its history, each on its own tab.
 */
function useProjectSections() {
  return useSectionTabs([
    { id: "members", label: "Members" },
    { id: "forms", label: "Forms" },
    { id: "setup", label: "Project setup" },
    { id: "activity", label: "Activity" },
  ] as const);
}

function ProjectSections({
  busy,
  change,
  detail,
  id,
  onNavigate,
  panel,
}: {
  busy: boolean;
  change: ReturnType<typeof useProjectDetail>["change"];
  detail: NonNullable<ReturnType<typeof useProjectDetail>["detail"]>;
  id: string;
  onNavigate: (pathname: string) => void;
  panel: ReturnType<typeof useProjectSections>["panel"];
}) {
  return (
    <>
      {panel(
        "members",
        <ProjectMembers
          busy={busy}
          canManage={detail.canManage}
          directory={detail.directory}
          members={detail.project.members}
          onAdd={(userId) =>
            void change(() => balebase().api.projects.addMember(id, userId))
          }
          onRemove={(userId) =>
            void change(() => balebase().api.projects.removeMember(id, userId))
          }
        />,
      )}
      {panel(
        "forms",
        <ProjectFormTemplates
          templates={detail.project.templates}
          onNavigate={onNavigate}
          projectId={id}
        />,
      )}
      {panel(
        "setup",
        <ProjectTemplates
          available={detail.availableTemplates}
          busy={busy}
          canManage={detail.canManage}
          enabled={detail.project.templates}
          onToggle={(templateId, on) =>
            void change(() =>
              balebase().api.projects.setForm(id, templateId, on),
            )
          }
        />,
      )}
      {panel(
        "activity",
        <ActivityFeed
          refreshKey={detail.project}
          source={{ id, type: "project" }}
        />,
      )}
    </>
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
      description="Members' devices sync the project's form templates, so they can start forms offline."
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
              <ListRow
                items={
                  canManage
                    ? [
                        {
                          disabled: busy,
                          icon: "userRemove",
                          id: "remove",
                          label: "Remove from project",
                          onSelect: () => onRemove(member.id),
                        },
                      ]
                    : []
                }
                key={member.id}
                meta={member.email}
                title={member.name || member.email}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState compact icon="userAdd" title="No members yet" />
      )}
    </PageSection>
  );
}

const managerTemplateCopy = {
  global: {
    description: "Published templates available in every organization.",
    emptyMessage: "No global templates are published yet.",
    emptyTitle: "No global templates",
    title: "Global templates",
  },
  organization: {
    description: "This organization's published templates.",
    emptyMessage:
      "Publish an organization template from Forms to turn it on here.",
    emptyTitle: "No published organization templates",
    title: "Organization templates",
  },
};

const memberTemplateCopy = {
  global: {
    ...managerTemplateCopy.global,
    emptyMessage: undefined,
    emptyTitle: "No global templates turned on",
  },
  organization: {
    ...managerTemplateCopy.organization,
    emptyMessage: undefined,
    emptyTitle: "No organization templates turned on",
  },
};

/**
 * The form templates the project can use, laid out like the Forms page's
 * collections. Managers see every published template and turn each on or off;
 * members see the ones turned on. Templates are edited from Forms, not here.
 */
function ProjectTemplates({
  available,
  busy,
  canManage,
  enabled,
  onToggle,
}: {
  available: Template[];
  busy: boolean;
  canManage: boolean;
  enabled: Template[];
  onToggle: (templateId: string, on: boolean) => void;
}) {
  const [view, setView] = useState(() => readFormTemplateView());
  const isOn = (template: Template) =>
    enabled.some((entry) => entry.id === template.id);
  return (
    <PageSection
      actions={
        <div className="formTemplateToolbar">
          <span className="sectionCount">
            {countLabel(enabled.length, "template")} on
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
      description="Turn on the form templates this project uses. Only published templates are listed; members' devices sync the ones turned on."
      title="Project setup"
    >
      <TemplateCollections
        actions={
          canManage
            ? (template) => (
                <TemplateToggle
                  busy={busy}
                  name={template.name}
                  on={isOn(template)}
                  onChange={(on) => onToggle(template.id, on)}
                />
              )
            : undefined
        }
        copy={canManage ? managerTemplateCopy : memberTemplateCopy}
        templates={canManage ? available : enabled}
        view={view}
      />
    </PageSection>
  );
}

function TemplateToggle({
  busy,
  name,
  on,
  onChange,
}: {
  busy: boolean;
  name: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="check formTemplateToggle">
      <input
        aria-checked={on}
        aria-label={`Use ${name} in this project`}
        checked={on}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
      {on ? "On" : "Off"}
    </label>
  );
}
