import {
  Badge,
  Banner,
  Card,
  EmptyState,
  LoadingState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import { useCallback } from "react";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { projectPath } from "../workspace/workspacePaths";

/**
 * The organization's projects and whether this form is on for each, from the
 * form's own page. Managers turn it on or off per project, as each project's
 * setup does; members see where it is on.
 */
export function FormProjects({
  formName,
  onNavigate,
  templateId,
}: {
  formName: string;
  onNavigate: (pathname: string) => void;
  templateId: string;
}) {
  const loaded = useLoad(
    useCallback(() => api.projects.formProjects(templateId), [templateId]),
    "Could not load projects.",
  );
  const action = useAction("Could not change the project's forms.");
  const listing = loaded.data;

  const toggle = (projectId: string, on: boolean) =>
    action.run(async () => {
      await api.projects.setForm(projectId, templateId, on);
      await loaded.reload();
    });

  const error = action.error ?? loaded.error;
  return (
    <PageSection
      actions={listing?.available && <OnCount projects={listing.projects} />}
      description="Members of each project this form is on for sync it to their devices and start audits from it."
      title="Projects"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {listing ? (
        <ProjectList
          busy={action.busy}
          formName={formName}
          listing={listing}
          onNavigate={onNavigate}
          onToggle={toggle}
        />
      ) : (
        !loaded.error && <LoadingState label="Loading projects…" />
      )}
    </PageSection>
  );
}

type Listing = Awaited<ReturnType<typeof api.projects.formProjects>>;

function OnCount({ projects }: { projects: Listing["projects"] }) {
  return (
    <span className="sectionCount">
      On for{" "}
      {countLabel(projects.filter(({ enabled }) => enabled).length, "project")}
    </span>
  );
}

function ProjectList({
  busy,
  formName,
  listing,
  onNavigate,
  onToggle,
}: {
  busy: boolean;
  formName: string;
  listing: Listing;
  onNavigate: (pathname: string) => void;
  onToggle: (projectId: string, on: boolean) => Promise<boolean>;
}) {
  if (!listing.available)
    return (
      <Banner announce={false} icon="lock" tone="neutral">
        Publish this form to turn it on for projects.
      </Banner>
    );
  if (!listing.projects.length)
    return (
      <EmptyState compact icon="layers" title="No projects yet">
        Create a project from Projects to turn this form on for it.
      </EmptyState>
    );
  return (
    <Card flush>
      <ul className="rowList projectList">
        {listing.projects.map((project) => (
          <li className="row" key={project.id}>
            <span className="rowMain">
              <AppLink
                className="rowTitle truncate"
                href={projectPath(project.id)}
                onNavigate={onNavigate}
              >
                {project.name}
              </AppLink>
            </span>
            {listing.canManage ? (
              <ProjectSwitch
                busy={busy}
                label={`Use ${formName} in ${project.name}`}
                on={project.enabled}
                onChange={(on) => void onToggle(project.id, on)}
              />
            ) : (
              <Badge tone={project.enabled ? "success" : "neutral"}>
                {project.enabled ? "On" : "Off"}
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ProjectSwitch({
  busy,
  label,
  on,
  onChange,
}: {
  busy: boolean;
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="check auditTemplateToggle">
      <input
        aria-checked={on}
        aria-label={label}
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
