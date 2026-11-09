import {
  Banner,
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
import type { NewProject, ProjectSummary } from "@balebase/validators/projects";
import { useCallback, useState } from "react";
import { useDevice } from "../offline/offlineContext";
import { api } from "../shared/apiClient";
import { ListRow } from "../shared/ListRow";
import { countLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import {
  projectAuditForPath,
  projectIdForPath,
  projectPath,
} from "../workspace/workspacePaths";
import { DeletedProjects } from "./DeletedProjects";
import {
  DeviceAuditPage,
  DeviceProjects,
  unreachableNotice,
} from "./DeviceProjects";
import { DeviceSyncStatus } from "./DeviceSyncStatus";
import { OtherDeviceAudits } from "./ProjectAuditForms";
import { ProjectDetailPage } from "./ProjectDetail";
import { ProjectForm } from "./ProjectForm";
import { confirmProjectDeletion, editedFields } from "./projectChanges";

export function Projects({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  // The App shows a device audit itself while this device holds it; this
  // shows one it does not.
  const audit = projectAuditForPath(pathname);
  if (audit) return <DeviceAuditPage {...audit} onNavigate={onNavigate} />;
  const projectId = projectIdForPath(pathname);
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  return projectId ? (
    <ProjectDetailPage id={projectId} key={projectId} onNavigate={onNavigate} />
  ) : (
    <ProjectListPage onNavigate={onNavigate} />
  );
}

/** The form open above the list: none, a new project, or an edit of one. */
type ProjectListForm =
  | { status: "closed" }
  | { status: "adding" }
  | { project: ProjectSummary; status: "editing" };

/**
 * The form open above the list, and the edits and deletions made from the
 * list's rows, each of which reloads it. As on a project's page, a refused
 * edit keeps its text, and reloading lets the next edit start from the latest
 * revision.
 */
function useProjectListChanges(reload: () => Promise<boolean>) {
  const action = useAction("Could not update the project.");
  const [form, setForm] = useState<ProjectListForm>({ status: "closed" });
  // Counts deletions, each of which Deleted projects reloads to list.
  const [deletions, setDeletions] = useState(0);
  const closeForm = () => setForm({ status: "closed" });

  async function save(
    project: ProjectSummary,
    input: { description: string; name: string },
  ) {
    const saved = await action.run(async () => {
      await api.projects.update(project.id, editedFields(project, input));
      await reload();
    }, "Project updated.");
    if (saved) closeForm();
    else void reload();
    return saved;
  }

  async function remove(project: ProjectSummary) {
    if (!(await confirmProjectDeletion(project))) return;
    const deleted = await action.run(async () => {
      await api.projects.delete(project.id);
      await reload();
    });
    if (deleted) setDeletions((count) => count + 1);
  }

  return {
    busy: action.busy,
    closeForm,
    deletions,
    error: action.error,
    form,
    notice: action.notice,
    remove,
    save,
    setForm,
  };
}

function ProjectListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.projects.list(), []),
    "Could not load projects.",
  );
  const creating = useAction("Could not create the project.");
  const changes = useProjectListChanges(loaded.reload);
  const { form, setForm } = changes;
  const listing = loaded.data;
  const error = creating.error ?? changes.error ?? loaded.error;
  const { workspace } = useDevice();

  const add = (input: NewProject) =>
    creating.run(async () => {
      const created = await api.projects.create(input);
      onNavigate(projectPath(created.id));
    });

  // The API can be unreachable while the device reports a network (a
  // captive portal, an outage): its copy still lets audits go on.
  if (!listing && loaded.error && workspace)
    return (
      <DeviceProjects
        notice={unreachableNotice}
        onNavigate={onNavigate}
        pathname={projectPath()}
      />
    );

  return (
    <Page>
      <PageHeader
        actions={
          listing?.canManage &&
          form.status === "closed" && (
            <Button
              icon="add"
              onClick={() => setForm({ status: "adding" })}
              variant="primary"
            >
              New project
            </Button>
          )
        }
        description="Group people around the audit forms they use. Your projects and their forms sync to this device, so audits can start without a connection."
        eyebrow="Workspace"
        title="Projects"
      />
      <PageBody>
        <DeviceSyncStatus />
        {error && <Toast tone="danger">{error}</Toast>}
        {changes.notice && <Toast tone="success">{changes.notice}</Toast>}
        {!listing ? (
          !error && <LoadingState label="Loading projects…" />
        ) : (
          <>
            {!listing.canManage && (
              <Banner announce={false} icon="lock" tone="neutral">
                Only organization owners and admins can create and change
                projects.
              </Banner>
            )}
            {form.status === "adding" && (
              <ProjectForm onCancel={changes.closeForm} onSave={add} />
            )}
            {form.status === "editing" && (
              <ProjectForm
                initial={form.project}
                onCancel={changes.closeForm}
                onSave={(input) => changes.save(form.project, input)}
              />
            )}
            <PageSection
              actions={
                <span className="sectionCount">
                  {countLabel(listing.projects.length, "project")}
                </span>
              }
              title="All projects"
            >
              <ProjectList
                canManage={listing.canManage}
                // Row actions wait while a form is open or a change runs.
                disabled={changes.busy || form.status !== "closed"}
                onAdd={() => setForm({ status: "adding" })}
                onDelete={(project) => void changes.remove(project)}
                onEdit={(project) => setForm({ project, status: "editing" })}
                onNavigate={onNavigate}
                projects={listing.projects}
              />
            </PageSection>
            <DeletedProjects
              deletions={changes.deletions}
              onNavigate={onNavigate}
            />
            <OtherDeviceAudits onNavigate={onNavigate} />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ProjectList({
  canManage,
  disabled,
  onAdd,
  onDelete,
  onEdit,
  onNavigate,
  projects,
}: {
  canManage: boolean;
  disabled: boolean;
  onAdd: () => void;
  onDelete: (project: ProjectSummary) => void;
  onEdit: (project: ProjectSummary) => void;
  onNavigate: (pathname: string) => void;
  projects: ProjectSummary[];
}) {
  if (!projects.length)
    return (
      <EmptyState
        actions={
          canManage && (
            <Button icon="add" onClick={onAdd} variant="primary">
              New project
            </Button>
          )
        }
        icon="layers"
        title="No projects yet"
      >
        Create a project, add the people working on it, and turn on the audit
        forms they need.
      </EmptyState>
    );
  return (
    <Card flush>
      <ul className="rowList">
        {projects.map((project) => (
          <ListRow
            icon="layers"
            items={
              canManage
                ? [
                    {
                      disabled,
                      icon: "edit",
                      id: "edit",
                      label: "Edit",
                      onSelect: () => onEdit(project),
                    },
                    {
                      disabled,
                      icon: "trash",
                      id: "delete",
                      label: "Delete",
                      onSelect: () => onDelete(project),
                    },
                  ]
                : []
            }
            key={project.id}
            meta={`${countLabel(project.memberCount, "member")} · ${countLabel(project.formCount, "audit form")}${project.isMember ? " · You are a member" : ""}`}
            open={{ href: projectPath(project.id), onNavigate }}
            title={project.name}
          />
        ))}
      </ul>
    </Card>
  );
}
