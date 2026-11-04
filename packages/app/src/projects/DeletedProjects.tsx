import { Button, Card, Icon, PageSection, Toast } from "@balebase/ui/react";
import { useCallback } from "react";
import { api } from "../shared/apiClient";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { projectPath } from "../workspace/workspacePaths";

/**
 * Deleted projects, which keep their audits, members, and forms, and which
 * managers can restore. Shown only while there are some.
 */
export function DeletedProjects({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.projects.listDeleted(), []),
    "Could not load deleted projects.",
  );
  const action = useAction("Could not restore the project.");
  const listing = loaded.data;
  // A failed load says so, so deleted projects stay within reach.
  if (!listing && loaded.error)
    return (
      <PageSection title="Deleted projects">
        <Toast tone="danger">{loaded.error}</Toast>
        <Button icon="refresh" onClick={() => void loaded.reload()} size="sm">
          Retry
        </Button>
      </PageSection>
    );
  if (!listing?.projects.length) return null;

  const restore = (id: string) =>
    action.run(async () => {
      await api.projects.restore(id);
      onNavigate(projectPath(id));
    });

  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(listing.projects.length, "project")}
        </span>
      }
      description="Their audits stay in Audits. Restoring a project brings back its members and forms."
      title="Deleted projects"
    >
      {action.error && <Toast tone="danger">{action.error}</Toast>}
      <Card flush>
        <ul className="rowList projectList">
          {listing.projects.map((project) => (
            <li className="row" key={project.id}>
              <span className="iconTile">
                <Icon name="trash" size={20} />
              </span>
              <span className="rowMain">
                <span className="rowTitle truncate">{project.name}</span>
                <span className="rowMeta truncate">
                  Deleted {formatDate(project.deletedAt)}
                  {project.deletedBy ? ` by ${project.deletedBy.name}` : ""}
                </span>
              </span>
              {listing.canManage && (
                <Button
                  disabled={action.busy}
                  icon="restore"
                  onClick={() => void restore(project.id)}
                  size="sm"
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
