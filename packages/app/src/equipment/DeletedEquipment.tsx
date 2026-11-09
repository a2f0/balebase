import { Button, Card, PageSection, Toast } from "@balebase/ui/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatDate } from "../shared/labels";
import { useLoad } from "../shared/useLoad";
import { equipmentPath } from "../workspace/workspacePaths";
import {
  deletedEquipmentTransition,
  initialDeletedEquipment,
} from "./deletedEquipmentState";
import { equipmentName } from "./equipmentLabels";

/**
 * Deleted equipment, which keeps its assignee, email links, and history, and
 * which managers can restore. Shown only while there is some.
 */
export function DeletedEquipment({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.equipment.listDeleted(), []),
    "Could not load deleted equipment.",
  );
  const { reload } = loaded;
  const [restore, dispatch] = useReducer(
    deletedEquipmentTransition,
    initialDeletedEquipment,
  );
  const requests = useRef(0);
  // Entering `restored` opens the item. An unmounted section runs no
  // effects, so a restore that finishes after the person left stays put.
  useEffect(() => {
    if (restore.status === "restored") onNavigate(equipmentPath(restore.id));
  }, [restore, onNavigate]);
  const listing = loaded.data;
  // A failed load says so, with a retry, so deleted equipment stays within
  // reach.
  const failure = loaded.error && (
    <>
      <Toast tone="danger">{loaded.error}</Toast>
      <Button icon="refresh" onClick={() => void reload()} size="sm">
        Retry
      </Button>
    </>
  );
  if (!listing?.equipment.length)
    return failure ? (
      <PageSection title="Deleted equipment">{failure}</PageSection>
    ) : null;

  async function restoreItem(id: string) {
    requests.current += 1;
    const request = requests.current;
    dispatch({ request, type: "restoreStarted" });
    try {
      const item = await api.equipment.restore(id);
      dispatch({ id: item.id, request, type: "restoreSucceeded" });
    } catch (cause) {
      dispatch({
        error: errorMessage(cause, "Could not restore the equipment."),
        request,
        type: "restoreFailed",
      });
    }
  }

  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(listing.equipment.length, "item")}
        </span>
      }
      description="Restoring an item brings back its assignee and linked emails."
      title="Deleted equipment"
    >
      {failure}
      {restore.status === "failed" && (
        <Toast tone="danger">{restore.error}</Toast>
      )}
      <Card flush>
        <ul className="rowList">
          {listing.equipment.map((item) => (
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
                        onSelect: () => void restoreItem(item.id),
                      },
                    ]
                  : []
              }
              key={item.id}
              meta={`Deleted ${formatDate(item.deletedAt)}${item.deletedBy ? ` by ${item.deletedBy.name}` : ""}`}
              title={equipmentName(item)}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}
