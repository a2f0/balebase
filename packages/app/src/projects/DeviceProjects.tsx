import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@balebase/ui/react";
import { OfflineAuditEditor } from "../offline/OfflineAuditEditor";
import { useDevice } from "../offline/offlineContext";
import { AppLink } from "../shared/AppLink";
import { countLabel } from "../shared/labels";
import {
  projectAuditForPath,
  projectIdForPath,
  projectPath,
} from "../workspace/workspacePaths";
import { DeviceSyncStatus } from "./DeviceSyncStatus";
import { ProjectAuditForms } from "./ProjectAuditForms";

/**
 * Projects as this device keeps them, for when it is offline or signed out:
 * the person's projects, each with its forms to start audits from and the
 * audits started here. Everything else about a project needs a connection.
 */
export function DeviceProjects({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const audit = projectAuditForPath(pathname);
  if (audit) return <DeviceAuditPage {...audit} onNavigate={onNavigate} />;
  const projectId = projectIdForPath(pathname);
  return projectId ? (
    <DeviceProjectPage id={projectId} onNavigate={onNavigate} />
  ) : (
    <DeviceProjectList onNavigate={onNavigate} />
  );
}

function DeviceHeader({ description }: { description: string }) {
  const { workspace } = useDevice();
  return (
    <PageHeader
      description={description}
      eyebrow={workspace?.organizationName ?? "On this device"}
      title="Projects"
    />
  );
}

function DeviceProjectList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  const projects = workspace?.projects ?? [];
  return (
    <Page>
      <DeviceHeader description="Your projects as this device last synced them. Connect to see everything else." />
      <PageBody>
        <DeviceSyncStatus />
        <PageSection
          actions={
            <span className="sectionCount">
              {countLabel(projects.length, "project")}
            </span>
          }
          title="Your projects"
        >
          {projects.length ? (
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
                        <span className="rowTitle truncate">
                          {project.name}
                        </span>
                        <span className="rowMeta truncate">
                          {countLabel(project.formIds.length, "audit form")}
                        </span>
                      </span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState
              compact
              icon="layers"
              title="No projects on this device"
            >
              Connect and sign in to sync the projects you belong to.
            </EmptyState>
          )}
        </PageSection>
      </PageBody>
    </Page>
  );
}

function DeviceProjectPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  const project = workspace?.projects.find((entry) => entry.id === id);
  const forms = (workspace?.forms ?? []).filter((form) =>
    project?.formIds.includes(form.id),
  );
  return (
    <Page>
      <PageHeader
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
        eyebrow="Project · On this device"
        title={project?.name ?? "Project unavailable"}
      />
      <PageBody>
        <DeviceSyncStatus />
        {project ? (
          <ProjectAuditForms
            forms={forms}
            onNavigate={onNavigate}
            projectId={id}
          />
        ) : (
          <Banner tone="neutral">
            This project is not on this device. Connect to open it.
          </Banner>
        )}
      </PageBody>
    </Page>
  );
}

/** An audit this device started, open for answers until it is completed. */
export function DeviceAuditPage({
  auditId,
  onNavigate,
  projectId,
}: {
  auditId: string;
  onNavigate: (pathname: string) => void;
  projectId: string;
}) {
  const { error, workspace } = useDevice();
  const audit = workspace?.audits.find((entry) => entry.id === auditId);
  const project = workspace?.projects.find((entry) => entry.id === projectId);
  // Navigating asks the unsaved-changes guards itself.
  const back = () => onNavigate(projectPath(projectId));
  return (
    <Page>
      <PageHeader
        back={
          <Button icon="arrowLeft" onClick={back} size="sm" variant="ghost">
            {project?.name ?? "Project"}
          </Button>
        }
        eyebrow="Audit · On this device"
        title={audit ? audit.template.name : "Audit unavailable"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {audit && workspace ? (
          <OfflineAuditEditor
            audit={audit}
            key={audit.id}
            onNavigate={onNavigate}
            workspace={workspace}
          />
        ) : (
          workspace && (
            <Banner tone="neutral">
              This audit is not on this device. It may have been started in
              another account or browser.
            </Banner>
          )
        )}
      </PageBody>
    </Page>
  );
}
