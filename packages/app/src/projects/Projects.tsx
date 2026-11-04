import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
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
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
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

function ProjectListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.projects.list(), []),
    "Could not load projects.",
  );
  const action = useAction("Could not create the project.");
  const [adding, setAdding] = useState(false);
  const listing = loaded.data;
  const error = action.error ?? loaded.error;
  const { workspace } = useDevice();

  const add = (input: NewProject) =>
    action.run(async () => {
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
          !adding && (
            <Button
              icon="add"
              onClick={() => setAdding(true)}
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
            {adding && (
              <ProjectForm onCancel={() => setAdding(false)} onSave={add} />
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
                onAdd={() => setAdding(true)}
                onNavigate={onNavigate}
                projects={listing.projects}
              />
            </PageSection>
            <DeletedProjects onNavigate={onNavigate} />
            <OtherDeviceAudits onNavigate={onNavigate} />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ProjectList({
  canManage,
  onAdd,
  onNavigate,
  projects,
}: {
  canManage: boolean;
  onAdd: () => void;
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
      <ul className="rowList projectList">
        {projects.map((project) => (
          <li key={project.id}>
            <AppLink
              className="row"
              href={projectPath(project.id)}
              onNavigate={onNavigate}
            >
              <span className="iconTile">
                <Icon name="layers" size={20} />
              </span>
              <span className="rowMain">
                <span className="rowTitle truncate">{project.name}</span>
                <span className="rowMeta truncate">
                  {countLabel(project.memberCount, "member")} ·{" "}
                  {countLabel(project.formCount, "audit form")}
                  {project.isMember ? " · You are a member" : ""}
                </span>
              </span>
            </AppLink>
          </li>
        ))}
      </ul>
    </Card>
  );
}
