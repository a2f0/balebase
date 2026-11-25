import { productName } from "@balebase/ui/brand";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@balebase/ui/react";
import { OfflineFormEditor } from "../offline/OfflineFormEditor";
import { useDevice } from "../offline/offlineContext";
import { ListRow } from "../shared/ListRow";
import { countLabel } from "../shared/labels";
import {
  projectFormForPath,
  projectIdForPath,
  projectPath,
} from "../workspace/workspacePaths";
import { DeviceSyncStatus } from "./DeviceSyncStatus";
import {
  DeviceForms,
  OtherDeviceForms,
  ProjectFormTemplates,
} from "./ProjectFormTemplates";

/** Shown over the device's copy when the API cannot be reached. */
export const unreachableNotice = `Could not reach ${productName}. Showing this device's copy; it syncs when the connection returns.`;

/**
 * Projects as this device keeps them, for when it is offline or signed out:
 * the person's projects, each with its templates to start forms from and the
 * forms started here. Everything else about a project needs a connection.
 */
export function DeviceProjects({
  notice,
  onNavigate,
  pathname,
}: {
  /** Why the device's copy is showing, when the API could not be reached. */
  notice?: string | undefined;
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const form = projectFormForPath(pathname);
  if (form) return <DeviceFormPage {...form} onNavigate={onNavigate} />;
  const projectId = projectIdForPath(pathname);
  return projectId ? (
    <DeviceProjectPage id={projectId} notice={notice} onNavigate={onNavigate} />
  ) : (
    <DeviceProjectList notice={notice} onNavigate={onNavigate} />
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
  notice,
  onNavigate,
}: {
  notice: string | undefined;
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  const projects = workspace?.projects ?? [];
  return (
    <Page>
      <DeviceHeader description="Your projects as this device last synced them. Connect to see everything else." />
      <PageBody>
        {notice && <Banner tone="warning">{notice}</Banner>}
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
              <ul className="rowList">
                {projects.map((project) => (
                  <ListRow
                    icon="layers"
                    key={project.id}
                    meta={countLabel(
                      project.templateIds.length,
                      "form template",
                    )}
                    open={{ href: projectPath(project.id), onNavigate }}
                    title={project.name}
                  />
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
        <OtherDeviceForms onNavigate={onNavigate} />
      </PageBody>
    </Page>
  );
}

function DeviceProjectPage({
  id,
  notice,
  onNavigate,
}: {
  id: string;
  notice: string | undefined;
  onNavigate: (pathname: string) => void;
}) {
  const { workspace } = useDevice();
  const project = workspace?.projects.find((entry) => entry.id === id);
  const templates = (workspace?.templates ?? []).filter((template) =>
    project?.templateIds.includes(template.id),
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
        {notice && <Banner tone="warning">{notice}</Banner>}
        <DeviceSyncStatus />
        {project ? (
          <ProjectFormTemplates
            templates={templates}
            onNavigate={onNavigate}
            projectId={id}
          />
        ) : (
          <>
            <Banner tone="neutral">
              This project is not on this device's list. Connect to open it.
            </Banner>
            {/* Forms started for it before it left the list still finish. */}
            <DeviceForms
              onNavigate={onNavigate}
              projectId={id}
              workspace={workspace}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

/** A form this device started, open for answers until it is completed. */
export function DeviceFormPage({
  formId,
  onNavigate,
  projectId,
}: {
  formId: string;
  onNavigate: (pathname: string) => void;
  projectId: string;
}) {
  const { error, workspace } = useDevice();
  const form = workspace?.forms.find((entry) => entry.id === formId);
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
        eyebrow="Form · On this device"
        title={form ? form.template.name : "Form unavailable"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        <DeviceSyncStatus />
        {form && workspace ? (
          <OfflineFormEditor
            form={form}
            key={form.id}
            onNavigate={onNavigate}
            workspace={workspace}
          />
        ) : (
          workspace && (
            <Banner tone="neutral">
              This form is not on this device. It may have been started in
              another account or browser.
            </Banner>
          )
        )}
      </PageBody>
    </Page>
  );
}
