import { Button, Card, PageSection, Toast } from "@balebase/ui/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatDate } from "../shared/labels";
import { initialRestore, restoreTransition } from "../shared/restoreState";
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
  const [restore, dispatch] = useReducer(restoreTransition, initialRestore);
  const requests = useRef(0);
  // Entering `restored` opens the project. An unmounted section runs no
  // effects, so a restore that finishes after the person left stays put.
  useEffect(() => {
    if (restore.status === "restored") onNavigate(projectPath(restore.id));
  }, [restore, onNavigate]);
  const listing = loaded.data;
  // A failed load or refresh says so, with a retry, so deleted projects stay
  // within reach even when an earlier load found none.
  const failure = loaded.error && (
    <>
      <Toast tone="danger">{loaded.error}</Toast>
      <Button icon="refresh" onClick={() => void reload()} size="sm">
        Retry
      </Button>
    </>
  );
  if (!listing?.projects.length)
    return failure ? (
      <PageSection title="Deleted projects">{failure}</PageSection>
    ) : null;

  async function restoreProject(id: string) {
    requests.current += 1;
    const request = requests.current;
    dispatch({ request, type: "restoreStarted" });
    try {
      await api.projects.restore(id);
      dispatch({ id, request, type: "restoreSucceeded" });
    } catch (cause) {
      dispatch({
        error: errorMessage(cause, "Could not restore the project."),
        request,
        type: "restoreFailed",
      });
    }
  }

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
      {failure}
      {restore.status === "failed" && (
        <Toast tone="danger">{restore.error}</Toast>
      )}
      <Card flush>
        <ul className="rowList">
          {listing.projects.map((project) => (
            <ListRow
              icon="trash"
              items={
                listing.canManage
                  ? [
                      {
                        disabled:
                          restore.status === "restoring" ||
                          restore.status === "restored",
                        icon: "restore",
                        id: "restore",
                        label: "Restore",
                        onSelect: () => void restoreProject(project.id),
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
