import { Button, Card, PageSection, Toast } from "@balebase/ui/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatDate } from "../shared/labels";
import { initialRestore, restoreTransition } from "../shared/restoreState";
import { useLoad } from "../shared/useLoad";
import { businessPath } from "../workspace/workspacePaths";

/**
 * Deleted businesses, which keep their history and identifiers, and which
 * managers can restore. Shown only while there are some.
 */
export function DeletedBusinesses({
  deletions,
  onNavigate,
}: {
  /** Counts businesses deleted from the list above, each of which joins this. */
  deletions: number;
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.businesses.listDeleted(), []),
    "Could not load deleted businesses.",
  );
  const { reload } = loaded;
  useEffect(() => {
    if (deletions) void reload();
  }, [deletions, reload]);
  const [restore, dispatch] = useReducer(restoreTransition, initialRestore);
  const requests = useRef(0);
  // Entering `restored` opens the business. An unmounted section runs no
  // effects, so a restore that finishes after the person left stays put.
  useEffect(() => {
    if (restore.status === "restored") onNavigate(businessPath(restore.id));
  }, [restore, onNavigate]);
  const listing = loaded.data;
  // A failed load or refresh says so, with a retry, so deleted businesses
  // stay within reach even when an earlier load found none.
  const failure = loaded.error && (
    <>
      <Toast tone="danger">{loaded.error}</Toast>
      <Button icon="refresh" onClick={() => void reload()} size="sm">
        Retry
      </Button>
    </>
  );
  if (!listing?.businesses.length)
    return failure ? (
      <PageSection title="Deleted businesses">{failure}</PageSection>
    ) : null;

  async function restoreBusiness(id: string) {
    requests.current += 1;
    const request = requests.current;
    dispatch({ request, type: "restoreStarted" });
    try {
      const business = await api.businesses.restore(id);
      dispatch({ id: business.id, request, type: "restoreSucceeded" });
    } catch (cause) {
      dispatch({
        error: errorMessage(cause, "Could not restore the business."),
        request,
        type: "restoreFailed",
      });
    }
  }

  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(listing.businesses.length, "business", "businesses")}
        </span>
      }
      description="They keep their EIN and DUNS number, so restore a business rather than adding it again."
      title="Deleted businesses"
    >
      {failure}
      {restore.status === "failed" && (
        <Toast tone="danger">{restore.error}</Toast>
      )}
      <Card flush>
        <ul className="rowList">
          {listing.businesses.map((business) => (
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
                        onSelect: () => void restoreBusiness(business.id),
                      },
                    ]
                  : []
              }
              key={business.id}
              meta={`Deleted ${formatDate(business.deletedAt)}${business.deletedBy ? ` by ${business.deletedBy.name}` : ""}`}
              title={business.name}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
