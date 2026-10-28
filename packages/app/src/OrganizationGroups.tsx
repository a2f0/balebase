import {
  Avatar,
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import type { OrganizationGroup } from "@balebase/validators/organizationGroups";
import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "./apiClient";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";

export function OrganizationAccessSettings({
  onAccessChanged,
  organizationId,
}: {
  onAccessChanged: () => Promise<void>;
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
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      <OrganizationGroups
        groups={data.groups}
        members={data.members}
        onChanged={changed}
      />
    </>
  );
}

function OrganizationGroups({
  groups,
  members,
  onChanged,
}: {
  groups: OrganizationGroup[];
  members: OrganizationMember[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const { busy, error, run } = useAction("Could not add the group.");

  async function create(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    await run(async () => {
      await api.organizationGroups.create({
        capabilities: [],
        name: nextName,
        userIds: [],
      });
      setName("");
      await onChanged();
    });
  }

  return (
    <Card
      description="Control feature access for sets of organization members."
      flush
      title="Groups"
    >
      <form className="groupCreate" onSubmit={(event) => void create(event)}>
        <div className="groupCreateRow">
          <Field label="New group name">
            <input
              className="input"
              disabled={busy}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Operations"
              type="text"
              value={name}
            />
          </Field>
          <Button
            busy={busy}
            disabled={!name.trim()}
            icon="add"
            type="submit"
            variant="primary"
          >
            Add group
          </Button>
        </div>
        {error && <Toast tone="danger">{error}</Toast>}
      </form>
      <div className="groupList">
        {groups.length === 0 ? (
          <EmptyState compact icon="layers" title="No groups yet">
            Create a group to give a set of members access to features like
            Finance.
          </EmptyState>
        ) : (
          groups.map((group) => (
            <GroupEditor
              group={group}
              key={group.id}
              members={members}
              onChanged={onChanged}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function GroupEditor({
  group,
  members,
  onChanged,
}: {
  group: OrganizationGroup;
  members: OrganizationMember[];
  onChanged: () => Promise<void>;
}) {
  const editor = useGroupEditor(group, onChanged);
  return (
    <form className="groupPanel" onSubmit={(event) => void editor.save(event)}>
      <div className="groupPanelBody">
        <div className="groupPanelHeading">
          <Field className="groupNameField" label="Group name">
            <input
              className="input"
              disabled={editor.busy}
              maxLength={100}
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
        </div>
        <GroupMemberPicker
          disabled={editor.busy}
          memberIds={editor.memberIds}
          members={members}
          onToggle={editor.toggleMember}
        />
        {editor.error && <Toast tone="danger">{editor.error}</Toast>}
        {editor.notice && <Toast tone="success">{editor.notice}</Toast>}
      </div>
      <div className="groupPanelFooter">
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
        <Button
          busy={editor.action === "save"}
          disabled={editor.busy || !editor.name.trim()}
          size="sm"
          type="submit"
          variant="primary"
        >
          {editor.action === "save" ? "Saving…" : "Save group"}
        </Button>
      </div>
    </form>
  );
}

function useGroupEditor(
  group: OrganizationGroup,
  onChanged: () => Promise<void>,
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
    // A failed reload can leave this panel mounted; keep it usable.
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
    title: `Delete the ${name} group?`,
    tone: "danger",
  });
}
