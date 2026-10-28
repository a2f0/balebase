import { confirmDialog } from "@balebase/ui/react";
import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import { useCallback } from "react";
import { api } from "./apiClient";
import { authClient } from "./authClient";
import { throwIfRefused } from "./errors";
import {
  type OrganizationInvitationRole,
  organizationRoleValue,
  type WorkspaceOrganization,
} from "./organizationState";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";

type OrganizationPeopleState = ReturnType<typeof useOrganizationPeopleData>;

/** The organization's members and invitations, with action state. */
export function useOrganizationPeopleData(organizationId: string) {
  const loaded = useLoad(
    useCallback(
      async () =>
        organizationId ? api.organizationSettings.people() : undefined,
      [organizationId],
    ),
    "Could not load organization people.",
  );
  const action = useAction("Could not update organization people.");
  return {
    busy: action.busy || loaded.loading,
    data: loaded.data,
    error: action.error ?? loaded.error,
    load: loaded.reload,
    notice: action.notice,
    run: action.run,
    setNotice: action.setNotice,
  };
}

export function organizationPeopleActions(
  state: OrganizationPeopleState,
  organization: WorkspaceOrganization,
  onAccessChanged: () => Promise<void>,
) {
  async function cancelInvitation(invitationId: string) {
    await state.run(async () => {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId,
      });
      throwIfRefused(error, "Could not revoke this invitation.");
      await state.load();
    }, "Invitation revoked.");
  }

  async function updateMemberRole(
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) {
    if (organizationRoleValue(member.role) === role) return;
    await state.run(async () => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId: member.id,
        organizationId: organization.id,
        role,
      });
      throwIfRefused(error, "Could not update this member’s role.");
      await Promise.all([state.load(), onAccessChanged()]);
    }, `${member.user.name} is now an organization ${role}.`);
  }

  async function updateTwoFactorRequirement(
    member: OrganizationMember,
    required: boolean,
  ) {
    if (member.twoFactorRequired === required) return;
    await state.run(
      async () => {
        await api.organizationSettings.updateMemberTwoFactorRequirement(
          member.id,
          required,
        );
        await Promise.all([state.load(), onAccessChanged()]);
      },
      required
        ? `${member.user.name} must use two-factor authentication for this organization.`
        : `${member.user.name} is no longer required to use two-factor authentication for this organization.`,
    );
  }

  return {
    cancelInvitation,
    updateMemberRole,
    updateTwoFactorRequirement,
  };
}

/** Removes a member after confirmation; resolves whether they were removed. */
export async function removeOrganizationMember(
  member: OrganizationMember,
  organization: WorkspaceOrganization,
  state: OrganizationPeopleState,
  onAccessChanged: () => Promise<void>,
) {
  if (!(await confirmMemberRemoval(member, organization))) return false;
  return state.run(async () => {
    const { error } = await authClient.organization.removeMember({
      memberIdOrEmail: member.id,
      organizationId: organization.id,
    });
    throwIfRefused(error, "Could not remove this organization member.");
    await Promise.all([state.load(), onAccessChanged()]);
  }, `${member.user.name} was removed from the organization.`);
}

function confirmMemberRemoval(
  member: OrganizationMember,
  organization: WorkspaceOrganization,
) {
  return confirmDialog({
    confirmLabel: "Remove member",
    title: `Remove ${member.user.name} from ${organization.name}?`,
    tone: "danger",
  });
}
