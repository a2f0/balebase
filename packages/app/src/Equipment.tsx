import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import type {
  EquipmentInput,
  EquipmentItem,
  EquipmentMember,
} from "@balebase/validators/equipment";
import { useCallback, useState } from "react";
import { AppLink } from "./AppLink";
import { api } from "./apiClient";
import { Assignee } from "./EquipmentAssignee";
import { EquipmentDetailPage } from "./EquipmentDetail";
import { EquipmentForm } from "./EquipmentForm";
import { type AssigneeFilter, filterEquipment } from "./equipmentFilters";
import {
  equipmentMeta,
  equipmentName,
  equipmentTypeIcon,
  equipmentTypeLabel,
} from "./equipmentLabels";
import { countLabel } from "./labels";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import { equipmentIdForPath, equipmentPath } from "./workspacePaths";

export function Equipment({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const equipmentId = equipmentIdForPath(pathname);
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  return equipmentId ? (
    <EquipmentDetailPage
      id={equipmentId}
      key={equipmentId}
      onNavigate={onNavigate}
    />
  ) : (
    <EquipmentListPage onNavigate={onNavigate} />
  );
}

function useEquipmentListing() {
  const loaded = useLoad(
    useCallback(() => api.equipment.list(), []),
    "Could not load equipment.",
  );
  const { setData } = loaded;
  const action = useAction("Could not add the equipment.");
  const [adding, setAdding] = useState(false);

  const add = (input: EquipmentInput) =>
    action.run(
      async () => {
        const created = await api.equipment.create(input);
        setData((current) =>
          current
            ? { ...current, equipment: [created, ...current.equipment] }
            : current,
        );
        setAdding(false);
        return created;
      },
      (created) => `Added ${equipmentName(created)}.`,
    );
  return {
    add,
    adding,
    error: action.error ?? loaded.error,
    listing: loaded.data,
    notice: action.notice,
    setAdding,
  };
}

function EquipmentListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { add, adding, error, listing, notice, setAdding } =
    useEquipmentListing();
  const [typeFilter, setTypeFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>("everyone");
  const visible = filterEquipment(
    listing?.equipment ?? [],
    typeFilter,
    assigneeFilter,
  );

  return (
    <Page>
      <PageHeader
        actions={
          listing?.canManage &&
          !adding && (
            <Button
              icon="add"
              onClick={() => setAdding(true)}
              variant="primary"
            >
              Add equipment
            </Button>
          )
        }
        description="Computers, phones, and monitors your organization owns, who has them, and their receipts."
        eyebrow="Records"
        title="Equipment"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!listing ? (
          !error && <LoadingState label="Loading equipment…" />
        ) : (
          <>
            {!listing.canManage && <ReadOnlyNotice />}
            {adding && (
              <EquipmentForm
                members={listing.members}
                onCancel={() => setAdding(false)}
                onSave={add}
                types={listing.types}
              />
            )}
            <PageSection
              actions={
                <span className="sectionCount">
                  {visible.length === listing.equipment.length
                    ? countLabel(listing.equipment.length, "item")
                    : `${visible.length} of ${listing.equipment.length}`}
                </span>
              }
              title="Inventory"
            >
              {listing.equipment.length > 0 && (
                <EquipmentFilters
                  assignee={assigneeFilter}
                  members={listing.members}
                  onAssigneeChange={setAssigneeFilter}
                  onTypeChange={setTypeFilter}
                  type={typeFilter}
                  types={listing.types}
                />
              )}
              <EquipmentList
                canManage={listing.canManage}
                empty={listing.equipment.length === 0}
                equipment={visible}
                onAdd={() => setAdding(true)}
                onNavigate={onNavigate}
              />
            </PageSection>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ReadOnlyNotice() {
  return (
    <Banner announce={false} icon="lock" tone="neutral">
      Only organization owners and admins can add, change, or assign equipment.
      Anyone can link receipts to it from the Inbox.
    </Banner>
  );
}

function EquipmentFilters({
  assignee,
  members,
  onAssigneeChange,
  onTypeChange,
  type,
  types,
}: {
  assignee: AssigneeFilter;
  members: EquipmentMember[];
  onAssigneeChange: (assignee: AssigneeFilter) => void;
  onTypeChange: (type: string) => void;
  type: string;
  types: string[];
}) {
  return (
    <div className="equipmentFilters">
      <nav aria-label="Equipment types" className="segmented">
        {["all", ...types].map((value) => (
          <button
            aria-pressed={type === value}
            key={value}
            onClick={() => onTypeChange(value)}
            type="button"
          >
            {value !== "all" && (
              <Icon name={equipmentTypeIcon(value)} size={16} />
            )}
            {value === "all" ? "All" : equipmentTypeLabel(value)}
          </button>
        ))}
      </nav>
      <Select
        aria-label="Assigned to"
        className="inputSm equipmentAssigneeFilter"
        onChange={(event) => onAssigneeChange(event.target.value)}
        value={assignee}
      >
        <option value="everyone">Everyone</option>
        <option value="unassigned">Unassigned</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function EquipmentList({
  canManage,
  empty,
  equipment,
  onAdd,
  onNavigate,
}: {
  canManage: boolean;
  empty: boolean;
  equipment: EquipmentItem[];
  onAdd: () => void;
  onNavigate: (pathname: string) => void;
}) {
  if (empty) {
    return (
      <EmptyState
        actions={
          canManage && (
            <Button icon="add" onClick={onAdd} variant="primary">
              Add equipment
            </Button>
          )
        }
        icon="equipment"
        title="No equipment yet"
      >
        Track computers, phones, and monitors, who has each one, and the
        receipts that came with them.
      </EmptyState>
    );
  }
  if (!equipment.length) {
    return (
      <EmptyState compact icon="search" title="Nothing matches these filters" />
    );
  }
  return (
    <Card flush>
      <ul className="rowList equipmentList">
        {equipment.map((item) => {
          const path = equipmentPath(item.id);
          return (
            <li key={item.id}>
              <AppLink
                className="row equipmentRow"
                href={path}
                onNavigate={onNavigate}
              >
                <span className="iconTile">
                  <Icon name={equipmentTypeIcon(item.type)} size={20} />
                </span>
                <span className="rowMain">
                  <span className="rowTitle truncate">
                    {equipmentName(item)}
                  </span>
                  <span className="rowMeta truncate">
                    {equipmentMeta(item)}
                  </span>
                </span>
                {item.emailCount > 0 && (
                  <span className="equipmentEmailCount">
                    <Icon name="mail" size={14} />
                    <span aria-hidden="true">{item.emailCount}</span>
                    <span className="srOnly">
                      {countLabel(item.emailCount, "linked email")}
                    </span>
                  </span>
                )}
                <Assignee member={item.assignee} />
              </AppLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
