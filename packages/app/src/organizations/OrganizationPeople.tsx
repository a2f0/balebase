import { Banner, Button, LoadingState, Toast } from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import type { OrganizationPeopleData } from "@balebase/validators/organizationSettings";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  EmployeeForms,
  inRequirementScope,
  type RequirementScope,
} from "../employeeForms/EmployeeForms";
import { AppButtonLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { useFocusWhenFolded } from "../shared/useFocusWhenFolded";
import { myDocumentsPath } from "../workspace/workspacePaths";
import { InviteMemberForm } from "./InviteMemberForm";
import {
  OrganizationMembers,
  PendingInvitations,
} from "./OrganizationMemberList";
import {
  organizationPeopleActions,
  removeOrganizationMember,
  useOrganizationPeopleData,
} from "./organizationPeopleState";
import {
  canManageOrganization,
  type WorkspaceOrganization,
} from "./organizationState";

/**
 * The first invitation is sent from an open form. Once anyone else has joined
 * or been invited, the form folds behind an "Invite member" action so the
 * member list leads the page.
 */
export function OrganizationPeople({
  onAccessChanged,
  onNavigate,
  organization,
}: {
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
}) {
  const state = useOrganizationPeopleData(organization.id);
  const [inviting, setInviting] = useState(false);
  const summary = useRequirementSummary(state.data);
  const canManage = canManageOrganization(state.data?.memberRole);
  const hasOthers = Boolean(
    state.data &&
      (state.data.members.length > 1 || state.data.invitations.length > 0),
  );
  const formOpen = canManage && (inviting || !hasOthers);
  const inviteButton = useFocusWhenFolded(formOpen);

  if (!state.data) {
    return state.error ? (
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
      <LoadingState label="Loading people…" />
    );
  }

  return (
    <PeopleBody
      canManage={canManage}
      data={state.data}
      formOpen={formOpen}
      inviteAction={
        canManage && hasOthers && !inviting ? (
          <Button
            icon="userAdd"
            onClick={() => setInviting(true)}
            ref={inviteButton}
            size="sm"
            variant="primary"
          >
            Invite member
          </Button>
        ) : null
      }
      onAccessChanged={onAccessChanged}
      onInviteCancel={hasOthers ? () => setInviting(false) : undefined}
      onInviteDone={() => setInviting(false)}
      onInviteSubmitting={() => setInviting(true)}
      onNavigate={onNavigate}
      organization={organization}
      summary={summary}
      state={state}
    />
  );
}

function PeopleBody({
  canManage,
  data,
  formOpen,
  inviteAction,
  onAccessChanged,
  onInviteCancel,
  onInviteDone,
  onInviteSubmitting,
  onNavigate,
  organization,
  state,
  summary,
}: {
  canManage: boolean;
  data: OrganizationPeopleData;
  formOpen: boolean;
  inviteAction: ReactNode;
  onAccessChanged: () => Promise<void>;
  onInviteCancel: (() => void) | undefined;
  onInviteDone: () => void;
  /** Keeps the form open while it works, even as people reload around it. */
  onInviteSubmitting: () => void;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
  state: ReturnType<typeof useOrganizationPeopleData>;
  summary: ReturnType<typeof useRequirementSummary>;
}) {
  const actions = organizationPeopleActions(
    state,
    organization,
    onAccessChanged,
  );
  const unattached: RequirementScope = {
    kind: "unattached",
    memberIds: data.members.map(({ id }) => id),
  };
  const { requirements } = summary;
  const openCount = (matches: (requirement: EmployeeRequirement) => boolean) =>
    requirements.filter(
      (requirement) =>
        requirement.status !== "complete" && matches(requirement),
    ).length;
  return (
    <>
      {state.error && <Toast tone="danger">{state.error}</Toast>}
      {state.notice && <Toast tone="success">{state.notice}</Toast>}
      <SummaryError summary={summary} />
      {data.currentMemberId && (
        <OwnRequestsNotice
          count={openCount(
            (requirement) => requirement.memberId === data.currentMemberId,
          )}
          onNavigate={onNavigate}
        />
      )}
      {formOpen && (
        <InviteMemberForm
          key={organization.id}
          memberRole={data.memberRole}
          onCancel={onInviteCancel}
          onNavigate={onNavigate}
          onSent={async () => {
            await state.load();
            summary.reload();
          }}
          onSubmitting={onInviteSubmitting}
          onSuccess={(message) => {
            state.setNotice(message);
            onInviteDone();
          }}
          organizationId={organization.id}
        />
      )}
      <OrganizationMembers
        action={inviteAction}
        busy={state.busy}
        managerRole={data.memberRole}
        members={data.members}
        onNavigate={onNavigate}
        onRemove={async (member) => {
          await removeOrganizationMember(
            member,
            organization,
            state,
            onAccessChanged,
          );
        }}
        onRoleChange={actions.updateMemberRole}
        onTwoFactorRequiredChange={actions.updateTwoFactorRequirement}
        openRequests={(member) =>
          openCount((requirement) => requirement.memberId === member.id)
        }
      />
      {canManage && data.invitations.length > 0 && (
        <PendingInvitations
          busy={state.busy}
          invitations={data.invitations}
          onCancel={actions.cancelInvitation}
        />
      )}
      {canManage &&
        requirements.some((requirement) =>
          inRequirementScope(unattached, requirement),
        ) && (
          <EmployeeForms
            key={`${peopleKey(data)}:${summary.version}`}
            scope={unattached}
          />
        )}
    </>
  );
}

function peopleKey(data: OrganizationPeopleData) {
  return [...data.members, ...data.invitations].map(({ id }) => id).join(",");
}

/**
 * Requested forms and checks, for the list's counts and for requests without
 * a member page. Reloads when people or the viewer's access change, or on
 * demand after new requests. Managers see every request and members only
 * their own, so requests loaded for other access are never shown.
 */
function useRequirementSummary(data: OrganizationPeopleData | undefined) {
  const [summary, setSummary] = useState<{
    access: string;
    error?: string;
    requirements: EmployeeRequirement[];
    /** Counts loads, so views of the same requests can start over. */
    version: number;
  }>({ access: "", requirements: [], version: 0 });
  const sequence = useRef(0);
  const load = useCallback(async (access: string) => {
    const request = ++sequence.current;
    try {
      const { requirements } = await api.employeeForms.list();
      if (request !== sequence.current) return;
      setSummary(({ version }) => ({
        access,
        requirements,
        version: version + 1,
      }));
    } catch (cause) {
      if (request !== sequence.current) return;
      const error = errorMessage(
        cause,
        "Requested forms and checks could not be loaded.",
      );
      setSummary((current) => ({ ...current, error }));
    }
  }, []);
  const access = data ? `${data.memberRole}:${data.currentMemberId ?? ""}` : "";
  const reloadKey = data ? `${access}|${peopleKey(data)}` : "";
  useEffect(() => {
    if (reloadKey) void load(access);
  }, [access, load, reloadKey]);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );
  return {
    error: summary.error,
    reload: () => void load(access),
    requirements: summary.access === access ? summary.requirements : [],
    version: summary.version,
  };
}

function SummaryError({
  summary,
}: {
  summary: ReturnType<typeof useRequirementSummary>;
}) {
  if (!summary.error) return null;
  return (
    <Banner
      actions={
        <Button onClick={summary.reload} size="sm">
          Try again
        </Button>
      }
      tone="danger"
    >
      Requested forms and checks could not be loaded. {summary.error}
    </Banner>
  );
}

/** Points people at My documents, where they complete their own requests. */
function OwnRequestsNotice({
  count,
  onNavigate,
}: {
  count: number;
  onNavigate: (pathname: string) => void;
}) {
  if (count === 0) return null;
  const path = myDocumentsPath();
  return (
    <Banner
      actions={
        <AppButtonLink href={path} onNavigate={onNavigate} size="sm">
          Open My documents
        </AppButtonLink>
      }
      tone="info"
    >
      {count === 1
        ? "Your organization has requested a form or check from you."
        : `Your organization has requested ${count} forms or checks from you.`}
    </Banner>
  );
}
