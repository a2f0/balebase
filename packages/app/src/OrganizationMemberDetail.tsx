import {
  Avatar,
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import { EmployeeForms } from "./EmployeeForms";
import {
  MemberRoleControl,
  MemberTwoFactorControl,
  TwoFactorStatus,
} from "./memberControls";
import {
  organizationPeopleActions,
  removeOrganizationMember,
  useOrganizationPeopleData,
} from "./organizationPeopleState";
import {
  canManageOrganization,
  editableOrganizationRoles,
  type OrganizationInvitationRole,
  type WorkspaceOrganization,
} from "./organizationState";
import {
  handleNavigation,
  myDocumentsPath,
  organizationPeoplePath,
} from "./workspacePaths";

/**
 * One member: who they are, their role and two-factor requirement, and, for
 * managers, the forms and checks requested from them. People complete their
 * own requests in My documents, which their own page links to.
 */
export function OrganizationMemberDetail({
  memberId,
  onAccessChanged,
  onNavigate,
  organization,
}: {
  memberId: string;
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
}) {
  const state = useOrganizationPeopleData(organization.id);
  const actions = organizationPeopleActions(
    state,
    organization,
    onAccessChanged,
  );
  const data = state.data;
  const member = data?.members.find(({ id }) => id === memberId);
  const back = <BackToPeople onNavigate={onNavigate} />;

  if (!data) {
    return (
      <>
        {back}
        {state.error ? (
          <Banner
            actions={
              <Button onClick={() => void state.load()} size="sm">
                Try again
              </Button>
            }
            tone="danger"
          >
            {state.error}
          </Banner>
        ) : (
          <LoadingState label="Loading member…" />
        )}
      </>
    );
  }
  if (!member) {
    return (
      <>
        {back}
        <EmptyState icon="organization" title="This member isn’t here">
          They may have left or been removed from the organization.
        </EmptyState>
      </>
    );
  }

  const canManage = canManageOrganization(data.memberRole);
  const isSelf = data.currentMemberId === member.id;
  return (
    <>
      {back}
      {state.error && <Toast tone="danger">{state.error}</Toast>}
      {state.notice && <Toast tone="success">{state.notice}</Toast>}
      <MemberProfile
        busy={state.busy}
        canManage={canManage}
        isSelf={isSelf}
        member={member}
        onRemove={async () => {
          if (
            await removeOrganizationMember(
              member,
              organization,
              state,
              onAccessChanged,
            )
          ) {
            onNavigate(organizationPeoplePath());
          }
        }}
        onRoleChange={actions.updateMemberRole}
        onTwoFactorRequiredChange={actions.updateTwoFactorRequirement}
        roles={editableOrganizationRoles(
          data.memberRole,
          member.role,
          data.members.map(({ role }) => role),
        )}
      />
      {isSelf && <MyDocumentsNotice onNavigate={onNavigate} />}
      {canManage && (
        <EmployeeForms
          key={member.id}
          scope={{ kind: "member", memberId: member.id }}
        />
      )}
    </>
  );
}

function MyDocumentsNotice({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const path = myDocumentsPath();
  return (
    <Banner
      actions={
        <ButtonLink
          href={path}
          onClick={(event) => handleNavigation(event, path, onNavigate)}
          size="sm"
        >
          Open My documents
        </ButtonLink>
      }
      tone="info"
    >
      Fill out the forms and checks requested from you in My documents.
    </Banner>
  );
}

function BackToPeople({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const path = organizationPeoplePath();
  return (
    <div>
      <ButtonLink
        href={path}
        icon="arrowLeft"
        onClick={(event) => handleNavigation(event, path, onNavigate)}
        size="sm"
        variant="ghost"
      >
        All people
      </ButtonLink>
    </div>
  );
}

function MemberProfile({
  busy,
  canManage,
  isSelf,
  member,
  onRemove,
  onRoleChange,
  onTwoFactorRequiredChange,
  roles,
}: {
  busy: boolean;
  canManage: boolean;
  isSelf: boolean;
  member: OrganizationMember;
  onRemove: () => Promise<void>;
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  onTwoFactorRequiredChange: (
    member: OrganizationMember,
    required: boolean,
  ) => Promise<void>;
  roles: OrganizationInvitationRole[];
}) {
  return (
    <Card
      actions={
        roles.length > 1 && (
          <Button
            disabled={busy}
            onClick={() => void onRemove()}
            size="sm"
            variant="danger"
          >
            Remove from organization
          </Button>
        )
      }
      description={member.user.email}
      title={
        <span className="memberProfileTitle">
          <Avatar name={member.user.name} size="lg" />
          <span className="truncate">{member.user.name}</span>
          {isSelf && <Badge>You</Badge>}
        </span>
      }
    >
      <dl className="keyValue memberProfileDetails">
        <dt>Role</dt>
        <dd>
          <MemberRoleControl
            busy={busy}
            member={member}
            onChange={onRoleChange}
            roles={roles}
          />
        </dd>
        <dt>Joined</dt>
        <dd>{formatDate(member.joinedAt)}</dd>
        {canManage && (
          <>
            <dt>Last active</dt>
            <dd>
              {member.lastActiveAt ? formatDate(member.lastActiveAt) : "Never"}
            </dd>
            <dt>Two-factor</dt>
            <dd className="memberProfileTwoFactor">
              <TwoFactorStatus member={member} />
              <MemberTwoFactorControl
                busy={busy}
                canManage
                member={member}
                onChange={onTwoFactorRequiredChange}
              />
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
