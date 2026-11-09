import { Button, Card, PageSection, Toast } from "@balebase/ui/react";
import { useCallback, useEffect } from "react";
import { api } from "../shared/apiClient";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { projectPath } from "../workspace/workspacePaths";

/**
 * Deleted projects, which keep their audits, members, and forms, and which
 * managers can restore. Shown only while there are some.
 */
export function DeletedProjects({
  deletions,
  onNavigate,
}: {
  /** Counts projects deleted from the list above, each of which joins this. */
  deletions: number;
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.projects.listDeleted(), []),
    "Could not load deleted projects.",
  );
  const { reload } = loaded;
  useEffect(() => {
    if (deletions) void reload();
  }, [deletions, reload]);
  const action = useAction("Could not restore the project.");
  const listing = loaded.data;
  // A failed load says so, so deleted projects stay within reach.
  if (!listing && loaded.error)
    return (
      <PageSection title="Deleted projects">
        <Toast tone="danger">{loaded.error}</Toast>
        <Button icon="refresh" onClick={() => void reload()} size="sm">
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
        <ul className="rowList">
          {listing.projects.map((project) => (
            <ListRow
              icon="trash"
              items={
                listing.canManage
                  ? [
                      {
                        disabled: action.busy,
                        icon: "restore",
                        id: "restore",
                        label: "Restore",
                        onSelect: () => void restore(project.id),
                      },
                    ]
                  : []
              }
              key={project.id}
              meta={`Deleted ${formatDate(project.deletedAt)}${project.deletedBy ? ` by ${project.deletedBy.name}` : ""}`}
              title={project.name}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
