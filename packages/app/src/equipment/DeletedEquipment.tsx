import { Button, Card, PageSection, Toast } from "@balebase/ui/react";
import { useCallback } from "react";
import { api } from "../shared/apiClient";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { equipmentPath } from "../workspace/workspacePaths";
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
  const action = useAction("Could not restore the equipment.");
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

  const restore = (id: string) =>
    action.run(async () => {
      await api.equipment.restore(id);
      onNavigate(equipmentPath(id));
    });

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
      {action.error && <Toast tone="danger">{action.error}</Toast>}
      <Card flush>
        <ul className="rowList">
          {listing.equipment.map((item) => (
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
                        onSelect: () => void restore(item.id),
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
