import { Button, Card, Icon, LoadingState, Toast } from "@balebase/ui/react";
import { useCallback, useState } from "react";
import { authClient } from "./authClient";
import { throwIfRefused } from "./errors";
import { formatDateTime } from "./labels";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";

interface InvitationDetails {
  email: string;
  expiresAt: Date;
  id: string;
  inviterEmail: string;
  organizationName: string;
  role: string;
}

export function OrganizationInvitation({
  invitationId,
  onAccepted,
  onNavigate,
  onUseAnotherAccount,
}: {
  invitationId: string | null;
  onAccepted: () => Promise<void>;
  onNavigate: () => void;
  onUseAnotherAccount: () => void;
}) {
  const loaded = useLoad(
    useCallback(async () => {
      if (!invitationId)
        throw new Error("This invitation link is missing its ID.");
      const { data, error } = await authClient.organization.getInvitation({
        query: { id: invitationId },
      });
      throwIfRefused(error, "This invitation is invalid or expired.");
      return data as InvitationDetails;
    }, [invitationId]),
    "Could not load this invitation.",
  );
  const invitation = loaded.data;
  const acceptance = useAction("Could not accept this invitation.");
  const [accepted, setAccepted] = useState(false);
  const busy = loaded.loading || acceptance.busy;
  const error = acceptance.error ?? loaded.error;

  async function accept() {
    if (!invitationId) return;
    await acceptance.run(async () => {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      });
      throwIfRefused(error, "Could not accept this invitation.");
      setAccepted(true);
      await onAccepted();
    });
  }

  return (
    <div className="acceptInvitePage">
      <div className="acceptInvitePanel">
        <header className="acceptInviteHeader">
          <span aria-hidden="true" className="acceptInviteMark">
            <Icon name={accepted ? "success" : "mail"} size={22} />
          </span>
          <p className="eyebrow">Organization invitation</p>
          <h1 className="acceptInviteTitle">
            {accepted ? "You’re in" : "Join your team"}
          </h1>
        </header>
        {error && !isRecipientMismatch(error) && (
          <Toast tone="danger">{error}</Toast>
        )}
        {error && isRecipientMismatch(error) && (
          <WrongAccount onUseAnotherAccount={onUseAnotherAccount} />
        )}
        <InvitationStatus
          accepted={accepted}
          busy={busy}
          invitation={invitation}
          onAccept={() => void accept()}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function InvitationStatus({
  accepted,
  busy,
  invitation,
  onAccept,
  onNavigate,
}: {
  accepted: boolean;
  busy: boolean;
  invitation: InvitationDetails | undefined;
  onAccept: () => void;
  onNavigate: () => void;
}) {
  if (accepted && invitation) {
    return (
      <Card
        description="The organization is active for this session."
        title={`Welcome to ${invitation.organizationName}`}
      >
        <Button
          block
          iconEnd="arrowRight"
          onClick={onNavigate}
          variant="primary"
        >
          Open organization
        </Button>
      </Card>
    );
  }
  if (invitation) {
    return (
      <Card
        description={`Invited by ${invitation.inviterEmail} as ${invitation.role}.`}
        title={`Join ${invitation.organizationName}`}
      >
        <dl className="keyValue">
          <dt>Invited email</dt>
          <dd>{invitation.email}</dd>
          <dt>Expires</dt>
          <dd>{formatDateTime(invitation.expiresAt)}</dd>
        </dl>
        <Button block busy={busy} onClick={onAccept} variant="primary">
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </Card>
    );
  }
  if (busy) {
    return (
      <Card>
        <LoadingState label="Loading invitation…" />
      </Card>
    );
  }
  return null;
}

function WrongAccount({
  onUseAnotherAccount,
}: {
  onUseAnotherAccount: () => void;
}) {
  return (
    <Card
      description="Switch to the invited account from the account menu, or sign in to another account. You’ll return to this invitation."
      title="This invitation belongs to another account"
    >
      <Button
        block
        icon="userAdd"
        onClick={onUseAnotherAccount}
        variant="primary"
      >
        Sign in to another account
      </Button>
    </Card>
  );
}

function isRecipientMismatch(message: string) {
  return message.toLowerCase().includes("not the recipient");
}
