import {
  Button,
  Card,
  confirmDialog,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  EquipmentInput,
  EquipmentItem,
} from "@balebase/validators/equipment";
import type { Person } from "@balebase/validators/fields";
import type { LinkedEmail } from "@balebase/validators/inbox";
import { useCallback, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";
import { Assignee, AssigneeSelect } from "./EquipmentAssignee";
import { EquipmentForm } from "./EquipmentForm";
import {
  equipmentName,
  equipmentTypeIcon,
  equipmentTypeLabel,
} from "./equipmentLabels";
import { LinkedEmailList } from "./LinkedEmailList";
import { api } from "./shared/apiClient";
import { countLabel, formatCalendarDate } from "./shared/labels";
import { useAction } from "./shared/useAction";
import { useLoad } from "./shared/useLoad";
import { equipmentPath } from "./workspace/workspacePaths";

function useEquipmentDetail(
  id: string,
  onNavigate: (pathname: string) => void,
) {
  const loaded = useLoad(
    useCallback(() => api.equipment.get(id), [id]),
    "Could not load the equipment.",
  );
  const { reload, setData } = loaded;
  const action = useAction("Could not update the equipment.");
  const [editing, setEditing] = useState(false);

  const save = (changes: Partial<EquipmentInput>, message: string) =>
    action.run(async () => {
      const equipment = await api.equipment.update(id, changes);
      setData((current) => (current ? { ...current, equipment } : current));
    }, message);

  async function remove(item: EquipmentItem) {
    if (!(await confirmEquipmentDeletion(item))) return;
    await action.run(async () => {
      await api.equipment.delete(id);
      onNavigate(equipmentPath());
    });
  }

  const unlink = (email: LinkedEmail) =>
    action.run(async () => {
      await api.inbox.unlink(email.id, email.linkId);
      await reload();
    });
  return {
    busy: action.busy,
    detail: loaded.data,
    editing,
    error: action.error ?? loaded.error,
    notice: action.notice,
    remove,
    save,
    setEditing,
    unlink,
  };
}

export function EquipmentDetailPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const {
    busy,
    detail,
    editing,
    error,
    notice,
    remove,
    save,
    setEditing,
    unlink,
  } = useEquipmentDetail(id, onNavigate);
  const item = detail?.equipment;
  return (
    <Page>
      <EquipmentDetailHeader
        busy={busy}
        canEdit={Boolean(detail?.canManage && item && !editing)}
        item={item}
        onBack={() => onNavigate(equipmentPath())}
        onDelete={() => item && void remove(item)}
        onEdit={() => setEditing(true)}
        unavailable={Boolean(error)}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!detail || !item ? (
          !error && <LoadingState label="Loading equipment…" />
        ) : (
          <>
            {editing ? (
              <EquipmentForm
                initial={item}
                members={detail.members}
                onCancel={() => setEditing(false)}
                onSave={async (input) => {
                  const saved = await save(input, "Equipment updated.");
                  if (saved) setEditing(false);
                  return saved;
                }}
                types={detail.types}
              />
            ) : (
              <EquipmentDetails
                busy={busy}
                canManage={detail.canManage}
                item={item}
                members={detail.members}
                onAssign={(assigneeId) =>
                  void save(
                    { assigneeId },
                    assigneeId
                      ? "Equipment assigned."
                      : "Equipment unassigned.",
                  )
                }
              />
            )}
            <LinkedEmailList
              busy={busy}
              description="Receipts and other Inbox messages linked to this equipment."
              emails={detail.emails}
              emptyText="Open a receipt in the Inbox and link it to this equipment."
              onNavigate={onNavigate}
              onUnlink={(email) => void unlink(email)}
              title="Emails and receipts"
            />
            <ActivityFeed
              refreshKey={item}
              source={{ id, type: "equipment" }}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function EquipmentDetailHeader({
  busy,
  canEdit,
  item,
  onBack,
  onDelete,
  onEdit,
  unavailable,
}: {
  busy: boolean;
  canEdit: boolean;
  item: EquipmentItem | undefined;
  onBack: () => void;
  onDelete: () => void;
  onEdit: () => void;
  unavailable: boolean;
}) {
  let title = "Loading…";
  if (item) title = equipmentName(item);
  else if (unavailable) title = "Equipment unavailable";
  return (
    <PageHeader
      actions={
        canEdit && (
          <>
            <Button disabled={busy} icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <Button
              disabled={busy}
              icon="trash"
              onClick={onDelete}
              variant="danger"
            >
              Delete
            </Button>
          </>
        )
      }
      back={
        <Button icon="arrowLeft" onClick={onBack} size="sm" variant="ghost">
          Equipment
        </Button>
      }
      eyebrow={item ? equipmentTypeLabel(item.type) : "Equipment"}
      title={title}
    />
  );
}

function EquipmentDetails({
  busy,
  canManage,
  item,
  members,
  onAssign,
}: {
  busy: boolean;
  canManage: boolean;
  item: EquipmentItem;
  members: Person[];
  onAssign: (assigneeId: string | null) => void;
}) {
  return (
    <PageSection title="Details">
      <Card>
        <dl className="keyValue equipmentDetails">
          <dt>Type</dt>
          <dd>
            <span className="equipmentTypeInline">
              <Icon name={equipmentTypeIcon(item.type)} size={16} />
              {equipmentTypeLabel(item.type)}
            </span>
          </dd>
          <dt>Make</dt>
          <dd>{item.make}</dd>
          <dt>Model</dt>
          <dd>{item.model}</dd>
          <dt>Serial number</dt>
          <dd className={item.serialNumber ? "mono" : "equipmentMissing"}>
            {item.serialNumber ?? "Not recorded"}
          </dd>
          <dt>Purchase date</dt>
          <dd className={item.purchaseDate ? undefined : "equipmentMissing"}>
            {item.purchaseDate
              ? formatCalendarDate(item.purchaseDate)
              : "Not recorded"}
          </dd>
          <dt>Assigned to</dt>
          <dd>
            {canManage ? (
              <AssigneeSelect
                disabled={busy}
                label={`Assign ${equipmentName(item)}`}
                members={members}
                onChange={onAssign}
                value={item.assignee?.id ?? null}
              />
            ) : (
              <Assignee member={item.assignee} />
            )}
          </dd>
        </dl>
      </Card>
    </PageSection>
  );
}

function confirmEquipmentDeletion(item: EquipmentItem) {
  return confirmDialog({
    confirmLabel: "Delete equipment",
    message: item.emailCount
      ? `${countLabel(item.emailCount, "linked email")} will be unlinked but stay in the inbox.`
      : undefined,
    title: `Delete ${equipmentName(item)}?`,
    tone: "danger",
  });
}
