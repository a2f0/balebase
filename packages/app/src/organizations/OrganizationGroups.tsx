import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  SectionTabs,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type { OrganizationGroup } from "@balebase/validators/organizationGroups";
import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import { groupLimits } from "@balebase/validators/rules";
import { type FormEvent, useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { AppButtonLink, AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import {
  organizationGroupPath,
  organizationPeoplePath,
} from "../workspace/workspacePaths";
import { formatRoles } from "./organizationState";

/** The organization's groups, or one group's page when `groupId` is set. */
export function OrganizationAccessSettings({
  groupId,
  onAccessChanged,
  onNavigate,
  organizationId,
}: {
  groupId?: string | undefined;
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organizationId: string;
}) {
  const {
    data,
    error,
    reload: load,
  } = useLoad(
    useCallback(
      async () => (organizationId ? api.organizationGroups.list() : undefined),
      [organizationId],
    ),
    "Could not load groups.",
  );

  async function changed() {
    await Promise.all([load(), onAccessChanged()]);
  }

  if (!data && !error) {
    return <LoadingState label="Loading access settings…" />;
  }
  if (!data) {
    return (
      <Banner
        actions={
          <Button onClick={() => void load()} size="sm">
            Try again
          </Button>
        }
        tone="danger"
      >
        {error}
      </Banner>
    );
  }
  const group = data.groups.find(({ id }) => id === groupId);
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {groupId === undefined ? (
        <GroupList
          groups={data.groups}
          onChanged={changed}
          onNavigate={onNavigate}
        />
      ) : group ? (
        <GroupDetail
          group={group}
          key={group.id}
          members={data.members}
          onChanged={changed}
          onNavigate={onNavigate}
        />
      ) : (
        <>
          <BackToGroups onNavigate={onNavigate} />
          <EmptyState icon="layers" title="This group isn’t here">
            It may have been deleted.
          </EmptyState>
        </>
      )}
    </>
  );
}

/** One compact row per group; each opens the group's page. */
function GroupList({
  groups,
  onChanged,
  onNavigate,
}: {
  groups: OrganizationGroup[];
  onChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  return (
    <Card
      description="Control feature access for sets of organization members."
      flush
      title="Groups"
    >
      <GroupCreateForm onChanged={onChanged} onNavigate={onNavigate} />
      <ul className="rowList groupRows">
        {groups.map((group) => (
          <li key={group.id}>
            <AppLink
              className="row groupRow"
              href={organizationGroupPath(group.id)}
              onNavigate={onNavigate}
            >
              <span className="iconTile">
                <Icon name="layers" size={18} />
              </span>
              <span className="rowMain">
                <span className="groupRowTitle">
                  <span className="rowTitle truncate">{group.name}</span>
                  {group.builtIn && <Badge>Built-in</Badge>}
                </span>
                <span className="rowMeta truncate">{groupSummary(group)}</span>
              </span>
              <Icon name="chevronRight" size={16} />
            </AppLink>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Adds a group by name, then opens it to choose members and access. */
function GroupCreateForm({
  onChanged,
  onNavigate,
}: {
  onChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const [name, setName] = useState("");
  const { busy, error, run } = useAction("Could not add the group.");

  async function create(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    await run(async () => {
      const { id } = await api.organizationGroups.create({
        capabilities: [],
        name: nextName,
        userIds: [],
      });
      setName("");
      await onChanged();
      onNavigate(organizationGroupPath(id));
    });
  }

  return (
    <form className="groupCreate" onSubmit={(event) => void create(event)}>
      <div className="groupCreateRow">
        <input
          aria-label="New group name"
          className="input inputSm"
          disabled={busy}
          maxLength={groupLimits.name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New group name"
          type="text"
          value={name}
        />
        <Button
          busy={busy}
          disabled={!name.trim()}
          icon="add"
          size="sm"
          type="submit"
          variant="primary"
        >
          Add group
        </Button>
      </div>
      {error && <Toast tone="danger">{error}</Toast>}
    </form>
  );
}

function groupSummary(group: OrganizationGroup) {
  const members = countLabel(group.memberUserIds.length, "member");
  if (group.builtIn === "admins") return `${members} · Owners and admins`;
  return group.capabilities.includes("finance")
    ? `${members} · Finance access`
    : `${members} · No feature access`;
}

/**
 * One group: its members, the access it grants, and its history. The Admins
 * group follows member roles, so it shows its members and their role changes.
 */
function GroupDetail({
  group,
  members,
  onChanged,
  onNavigate,
}: {
  group: OrganizationGroup;
  members: OrganizationMember[];
  onChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const admins = group.builtIn === "admins";
  const editor = useGroupEditor(group, onChanged, onNavigate);
  const sections = useSectionTabs([
    { id: "members", label: "Members" },
    !admins && { id: "access", label: "Access" },
    { id: "history", label: "History" },
  ]);
  return (
    <>
      <BackToGroups onNavigate={onNavigate} />
      <GroupHeading editor={editor} group={group} />
      {editor.error && <Toast tone="danger">{editor.error}</Toast>}
      {editor.notice && <Toast tone="success">{editor.notice}</Toast>}
      <SectionTabs label="Group sections">{sections.tabs}</SectionTabs>
      {sections.panel(
        "members",
        admins ? (
          <AdminMembers
            group={group}
            members={members}
            onNavigate={onNavigate}
          />
        ) : (
          <GroupMembers editor={editor} members={members} />
        ),
      )}
      {sections.panel("access", <GroupAccess editor={editor} />)}
      {sections.panel(
        "history",
        <ActivityFeed
          refreshKey={group}
          source={{ id: group.id, type: "organization_group" }}
          title={admins ? "Role changes" : "History"}
        />,
      )}
    </>
  );
}

function GroupHeading({
  editor,
  group,
}: {
  editor: GroupEditor;
  group: OrganizationGroup;
}) {
  return (
    <Card
      actions={
        !group.builtIn && (
          <Button
            busy={editor.action === "delete"}
            disabled={editor.busy}
            icon="trash"
            onClick={() => void editor.remove()}
            size="sm"
            variant="danger"
          >
            {editor.action === "delete" ? "Deleting…" : "Delete group"}
          </Button>
        )
      }
      description={builtInDescription(group) ?? groupSummary(group)}
      title={
        <span className="groupDetailTitle">
          <span className="truncate">{group.name}</span>
          {group.builtIn && <Badge>Built-in</Badge>}
        </span>
      }
    />
  );
}

function builtInDescription(group: OrganizationGroup) {
  if (group.builtIn === "admins")
    return "Every owner and admin, kept in step with member roles. It can't be edited or deleted.";
  if (group.builtIn === "finance")
    return "The group every organization starts with. You can rename it and change its members and access, but not delete it.";
  return undefined;
}

function BackToGroups({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  return (
    <div>
      <AppButtonLink
        href={organizationGroupPath()}
        icon="arrowLeft"
        onNavigate={onNavigate}
        size="sm"
        variant="ghost"
      >
        All groups
      </AppButtonLink>
    </div>
  );
}

/** The Admins group's members, read-only: roles decide who is in it. */
function AdminMembers({
  group,
  members,
  onNavigate,
}: {
  group: OrganizationGroup;
  members: OrganizationMember[];
  onNavigate: (pathname: string) => void;
}) {
  const admins = members.filter(({ user }) =>
    group.memberUserIds.includes(user.id),
  );
  return (
    <Card
      actions={
        <AppButtonLink
          href={organizationPeoplePath()}
          onNavigate={onNavigate}
          size="sm"
        >
          Change roles in People
        </AppButtonLink>
      }
      description="Owners and admins manage the organization. Make someone an admin in People to add them here."
      flush
      title={countLabel(admins.length, "member")}
    >
      <ul className="rowList">
        {admins.map((member) => (
          <li className="row" key={member.id}>
            <Avatar name={member.user.name} size="sm" />
            <span className="rowMain">
              <span className="rowTitle truncate">{member.user.name}</span>
              <span className="rowMeta truncate">{member.user.email}</span>
            </span>
            <Badge>{formatRoles(member.role)}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GroupMembers({
  editor,
  members,
}: {
  editor: GroupEditor;
  members: OrganizationMember[];
}) {
  return (
    <form className="stack" onSubmit={(event) => void editor.save(event)}>
      <GroupMemberPicker
        disabled={editor.busy}
        memberIds={editor.memberIds}
        members={members}
        onToggle={editor.toggleMember}
      />
      <SaveGroup editor={editor} label="Save members" />
    </form>
  );
}

function GroupAccess({ editor }: { editor: GroupEditor }) {
  return (
    <Card title="Access">
      <form className="stack" onSubmit={(event) => void editor.save(event)}>
        <Field className="groupNameField" label="Group name">
          <input
            className="input"
            disabled={editor.busy}
            maxLength={groupLimits.name}
            onChange={(event) => editor.setName(event.target.value)}
            required
            type="text"
            value={editor.name}
          />
        </Field>
        <label className="check groupCapability">
          <input
            checked={editor.finance}
            disabled={editor.busy}
            onChange={(event) => editor.setFinance(event.target.checked)}
            type="checkbox"
          />
          Finance access
        </label>
        <SaveGroup editor={editor} label="Save group" />
      </form>
    </Card>
  );
}

function SaveGroup({ editor, label }: { editor: GroupEditor; label: string }) {
  return (
    <div className="cluster">
      <Button
        busy={editor.action === "save"}
        disabled={editor.busy || !editor.name.trim()}
        size="sm"
        type="submit"
        variant="primary"
      >
        {editor.action === "save" ? "Saving…" : label}
      </Button>
    </div>
  );
}

type GroupEditor = ReturnType<typeof useGroupEditor>;

/**
 * One editor for a group's name, access, and members, shared by its tabs:
 * either tab's save sends all three, so an edit on one tab is not lost by
 * saving the other.
 */
function useGroupEditor(
  group: OrganizationGroup,
  onChanged: () => Promise<void>,
  onNavigate: (pathname: string) => void,
) {
  const [name, setName] = useState(group.name);
  const [finance, setFinance] = useState(
    group.capabilities.includes("finance"),
  );
  const [memberIds, setMemberIds] = useState(
    () => new Set(group.memberUserIds),
  );
  // Which action is running, so only its button shows progress.
  const [action, setAction] = useState<"delete" | "save">();
  const { busy, error, notice, run } = useAction("Could not update the group.");
  const perform = async (
    next: "delete" | "save",
    work: () => Promise<void>,
    success?: string,
  ) => {
    setAction(next);
    await run(work, success);
    // A failed reload can leave this page mounted; keep it usable.
    setAction(undefined);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await perform(
      "save",
      async () => {
        await api.organizationGroups.update(group.id, {
          capabilities: finance ? ["finance"] : [],
          name: name.trim(),
          userIds: [...memberIds],
        });
        await onChanged();
      },
      "Group updated.",
    );
  };
  const remove = async () => {
    if (!(await confirmGroupDeletion(group.name))) return;
    await perform("delete", async () => {
      await api.organizationGroups.delete(group.id);
      onNavigate(organizationGroupPath());
      await onChanged();
    });
  };
  const toggleMember = (userId: string) =>
    setMemberIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  return {
    action,
    busy,
    error,
    finance,
    memberIds,
    name,
    notice,
    remove,
    save,
    setFinance,
    setName,
    toggleMember,
  };
}

function GroupMemberPicker({
  disabled,
  memberIds,
  members,
  onToggle,
}: {
  disabled: boolean;
  memberIds: Set<string>;
  members: OrganizationMember[];
  onToggle: (userId: string) => void;
}) {
  const selected = members.filter(({ user }) => memberIds.has(user.id)).length;
  return (
    <fieldset className="fieldset" disabled={disabled}>
      <legend>
        Members{" "}
        <span className="groupMembersCount">
          {selected} of {members.length} selected
        </span>
      </legend>
      <div className="gridAuto groupMemberGrid">
        {members.map((member) => (
          <label className="check groupMemberOption" key={member.id}>
            <input
              checked={memberIds.has(member.user.id)}
              onChange={() => onToggle(member.user.id)}
              type="checkbox"
            />
            <Avatar name={member.user.name} size="sm" />
            <span className="groupMemberText">
              <span className="groupMemberName truncate">
                {member.user.name}
              </span>
              <span className="groupMemberEmail truncate">
                {member.user.email}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function confirmGroupDeletion(name: string) {
  return confirmDialog({
    confirmLabel: "Delete group",
    message: "Its members lose the access it grants. Its history is kept.",
    title: `Delete the ${name} group?`,
    tone: "danger",
  });
}
