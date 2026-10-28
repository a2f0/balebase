import { Avatar, Badge, Button, Card, cx, Icon } from "@balebase/ui/react";
import type {
  OrganizationInvitation,
  OrganizationMember,
} from "@balebase/validators/organizationSettings";
import type { ReactNode } from "react";
import { AppLink } from "./AppLink";
import { formatDate } from "./labels";
import {
  MemberRoleControl,
  MemberTwoFactorControl,
  TwoFactorStatus,
} from "./MemberControls";
import {
  canManageOrganization,
  editableOrganizationRoles,
  formatRoles,
  type OrganizationInvitationRole,
} from "./organizationState";
import { organizationPeoplePath } from "./workspacePaths";

interface MemberControlsProps {
  busy: boolean;
  onNavigate: (pathname: string) => void;
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  onRemove: (member: OrganizationMember) => Promise<void>;
  onTwoFactorRequiredChange: (
    member: OrganizationMember,
    required: boolean,
  ) => Promise<void>;
  openRequests: (member: OrganizationMember) => number;
}

export function OrganizationMembers({
  action,
  managerRole,
  members,
  ...controls
}: MemberControlsProps & {
  action: ReactNode;
  managerRole: string;
  members: OrganizationMember[];
}) {
  const memberRoles = members.map(({ role }) => role);
  const canManage = canManageOrganization(managerRole);
  return (
    <Card
      actions={action}
      description={`${members.length} ${
        members.length === 1 ? "person has" : "people have"
      } access to this organization.`}
      flush
      title="Members"
    >
      <div className="memberListFrame">
        <ul
          className={cx(
            "rowList memberList",
            !canManage && "memberListReadOnly",
          )}
        >
          {members.map((member) => (
            <MemberRow
              {...controls}
              canManage={canManage}
              key={member.id}
              member={member}
              roles={editableOrganizationRoles(
                managerRole,
                member.role,
                memberRoles,
              )}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function MemberRow({
  busy,
  canManage,
  member,
  onNavigate,
  onRemove,
  onRoleChange,
  onTwoFactorRequiredChange,
  openRequests,
  roles,
}: MemberControlsProps & {
  canManage: boolean;
  member: OrganizationMember;
  roles: OrganizationInvitationRole[];
}) {
  const path = organizationPeoplePath(member.id);
  const open = openRequests(member);
  return (
    <li className="row memberRow">
      <AppLink
        className="memberIdentity memberLink"
        href={path}
        onNavigate={onNavigate}
      >
        <Avatar name={member.user.name} />
        <div className="rowMain">
          <span className="memberName">
            <span className="rowTitle truncate">{member.user.name}</span>
            {canManage && <TwoFactorStatus member={member} />}
            {open > 0 && (
              <Badge tone="info">
                {open} open {open === 1 ? "request" : "requests"}
              </Badge>
            )}
          </span>
          <span className="rowMeta truncate">
            {member.user.email}
            {canManage && ` · ${lastActiveLabel(member)}`}
          </span>
        </div>
      </AppLink>
      <div className="memberTwoFactor">
        <MemberTwoFactorControl
          busy={busy}
          canManage={canManage}
          member={member}
          onChange={onTwoFactorRequiredChange}
        />
      </div>
      <div className="memberRole">
        <MemberRoleControl
          busy={busy}
          member={member}
          onChange={onRoleChange}
          roles={roles}
        />
      </div>
      <div className="memberActions">
        {roles.length > 1 && (
          <Button
            disabled={busy}
            onClick={() => void onRemove(member)}
            size="sm"
            variant="danger"
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

export function PendingInvitations({
  busy,
  invitations,
  onCancel,
}: {
  busy: boolean;
  invitations: OrganizationInvitation[];
  onCancel: (invitationId: string) => Promise<void>;
}) {
  return (
    <Card
      description="Invitations that have not been accepted yet. Forms requested with an invitation move to the member’s page when they join."
      flush
      title="Pending invitations"
    >
      <ul className="rowList">
        {invitations.map((invitation) => (
          <li className="row" key={invitation.id}>
            <div className="memberIdentity">
              <span aria-hidden="true" className="invitationMark">
                <Icon name="mail" size={16} />
              </span>
              <div className="rowMain">
                <span className="rowTitle truncate">{invitation.email}</span>
                <span className="rowMeta">
                  {formatRoles(invitation.role)} · Expires{" "}
                  {formatDate(invitation.expiresAt)}
                </span>
              </div>
            </div>
            <Button
              disabled={busy}
              onClick={() => void onCancel(invitation.id)}
              size="sm"
              variant="danger"
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function lastActiveLabel({ lastActiveAt }: OrganizationMember) {
  return lastActiveAt
    ? `Last active ${formatDate(lastActiveAt)}`
    : "Never active";
}
