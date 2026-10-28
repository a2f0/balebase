import { Button, Card, Field, Select, Toast } from "@balebase/ui/react";
import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";
import { api } from "./apiClient";
import { authClient } from "./authClient";
import { RequirementDraftEditor } from "./EmployeeForms";
import { ErrorToast } from "./ErrorToast";
import {
  inviteWithRequirements,
  RequirementAssignmentError,
  type RequirementDraft,
} from "./employeeOnboarding";
import {
  assignableOrganizationRoles,
  formatRoles,
  type OrganizationInvitationRole,
} from "./organizationState";
import { useAction } from "./useAction";

export function InviteMemberForm({
  memberRole,
  onCancel,
  onNavigate,
  onSent,
  onSubmitting,
  onSuccess,
  organizationId,
}: {
  memberRole: string;
  /** Present when the form can fold away again. */
  onCancel: (() => void) | undefined;
  onNavigate: (pathname: string) => void;
  onSent: () => Promise<void>;
  onSubmitting: () => void;
  onSuccess: (message: string) => void;
  organizationId: string;
}) {
  const form = useInviteSubmission({
    onSent,
    onSubmitting,
    onSuccess,
    organizationId,
  });
  const emailField = useRef<HTMLInputElement>(null);
  // Opened from the header button, which is now gone; move focus into the
  // form. Decided once, so a later reload does not pull focus here.
  const [openedOnDemand] = useState(Boolean(onCancel));
  useEffect(() => {
    if (openedOnDemand) emailField.current?.focus();
  }, [openedOnDemand]);

  return (
    <Card
      description="They’ll receive a single-use invitation that expires in 48 hours."
      footer={
        <>
          {onCancel && (
            <Button disabled={form.busy} onClick={onCancel} variant="ghost">
              Cancel
            </Button>
          )}
          <Button
            busy={form.busy}
            disabled={!form.email.trim()}
            icon="mail"
            type="submit"
            variant="primary"
          >
            {form.busy ? "Sending…" : "Send invitation"}
          </Button>
        </>
      }
      onSubmit={(event) => void form.invite(event)}
      title="Invite a member"
    >
      <InviteFields
        busy={form.busy}
        email={form.email}
        emailField={emailField}
        memberRole={memberRole}
        onEmail={form.setEmail}
        onRole={form.setRole}
        role={form.role}
      />
      <div className="inviteRequirements">
        <h3>Onboarding requirements</h3>
        <p className="muted">
          Choose any forms or checks needed from this person and set each due
          date.
        </p>
        <RequirementDraftEditor
          drafts={form.requirements}
          disabled={form.busy}
          onChange={form.setRequirements}
        />
      </div>
      <InviteError form={form} onNavigate={onNavigate} />
    </Card>
  );
}

/** Sends an invitation with its requests, and retries requests that failed. */
function useInviteSubmission({
  onSent,
  onSubmitting,
  onSuccess,
  organizationId,
}: {
  onSent: () => Promise<void>;
  onSubmitting: () => void;
  onSuccess: (message: string) => void;
  organizationId: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationInvitationRole>("member");
  const { busy, failure, run } = useAction("Could not send this invitation.");
  const [requirements, setRequirements] = useState<RequirementDraft[]>([]);
  const [retry, setRetry] = useState<{ email: string; invitationId: string }>();

  async function invite(event: FormEvent) {
    event.preventDefault();
    const invitedEmail = email.trim().toLowerCase();
    if (!invitedEmail) return;
    setRetry(undefined);
    onSubmitting();
    await run(async () => {
      try {
        const assignedRole = await sendInvitationWithRequirements({
          email: invitedEmail,
          onInvited: () => setEmail(""),
          onSent,
          organizationId,
          requirements,
          role,
        });
        setRequirements([]);
        onSuccess(
          `Invitation sent to ${invitedEmail} with the ${assignedRole} role.`,
        );
      } catch (cause) {
        // The invitation went out but its requests did not: keep the drafts
        // and offer to send them to that invitation again.
        if (cause instanceof RequirementAssignmentError && cause.invitationId) {
          setRetry({ email: invitedEmail, invitationId: cause.invitationId });
        }
        throw cause;
      }
    });
  }

  async function retryRequests() {
    if (!retry) return;
    await run(async () => {
      await api.employeeForms.create(
        { invitationId: retry.invitationId },
        requirements,
      );
      setRequirements([]);
      setRetry(undefined);
      await onSent();
      onSuccess(`Invitation sent to ${retry.email}, with its requested forms.`);
    });
  }

  return {
    busy,
    email,
    error: failure,
    invite,
    requirements,
    retry,
    retryRequests,
    role,
    setEmail,
    setRequirements,
    setRole,
  };
}

function InviteError({
  form,
  onNavigate,
}: {
  form: ReturnType<typeof useInviteSubmission>;
  onNavigate: (pathname: string) => void;
}) {
  if (!form.retry || !form.error) {
    return <ErrorToast error={form.error} onNavigate={onNavigate} />;
  }
  return (
    <Toast
      actions={
        <Button
          busy={form.busy}
          disabled={!form.requirements.length}
          onClick={() => void form.retryRequests()}
          size="sm"
        >
          Retry requests
        </Button>
      }
      tone="danger"
    >
      {form.error.message}
    </Toast>
  );
}

function InviteFields({
  busy,
  email,
  emailField,
  memberRole,
  onEmail,
  onRole,
  role,
}: {
  busy: boolean;
  email: string;
  emailField: Ref<HTMLInputElement>;
  memberRole: string;
  onEmail: (email: string) => void;
  onRole: (role: OrganizationInvitationRole) => void;
  role: OrganizationInvitationRole;
}) {
  return (
    <div className="inviteFields">
      <Field label="Email address">
        <input
          autoCapitalize="none"
          autoComplete="email"
          className="input"
          disabled={busy}
          inputMode="email"
          name="invite-email"
          onChange={(event) => onEmail(event.target.value)}
          placeholder="name@company.com"
          ref={emailField}
          required
          spellCheck={false}
          type="email"
          value={email}
        />
      </Field>
      <Field hint={roleDescription(role)} label="Organization role">
        <Select
          disabled={busy}
          name="invite-role"
          onChange={(event) =>
            onRole(event.target.value as OrganizationInvitationRole)
          }
          value={role}
        >
          {assignableOrganizationRoles(memberRole).map((assignableRole) => (
            <option key={assignableRole} value={assignableRole}>
              {formatRoles(assignableRole)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

async function sendInvitationWithRequirements({
  email,
  onInvited,
  onSent,
  organizationId,
  requirements,
  role,
}: {
  email: string;
  onInvited: () => void;
  onSent: () => Promise<void>;
  organizationId: string;
  requirements: RequirementDraft[];
  role: OrganizationInvitationRole;
}) {
  return inviteWithRequirements({
    assign: (invitationId, drafts) =>
      api.employeeForms.create({ invitationId }, drafts),
    invite: async () => {
      const result = await authClient.organization.inviteMember({
        email,
        organizationId,
        role,
      });
      return {
        data: result.data
          ? { id: result.data.id, role: result.data.role }
          : null,
        error: result.error
          ? {
              code: result.error.code,
              message:
                result.error.message ?? "Could not send this invitation.",
            }
          : null,
      };
    },
    onInvited,
    onSent,
    requirements,
    role,
  });
}

function roleDescription(role: OrganizationInvitationRole) {
  if (role === "owner") return "Full access, including ownership controls.";
  if (role === "admin") return "Can manage people, groups, and settings.";
  return "Standard access to the organization workspace.";
}
