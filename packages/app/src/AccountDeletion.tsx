import { Button, Card, confirmDialog, Toast } from "@balebase/ui/react";
import { useEffect, useState } from "react";
import { api } from "./apiClient";

export function AccountDeletion() {
  const [requestedAt, setRequestedAt] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api.accountSettings
      .deletion()
      .then((body) => setRequestedAt(body.requestedAt))
      .catch((cause: unknown) => setError(messageFrom(cause)));
  }, []);

  async function update() {
    if (!requestedAt && !(await confirmDeletionRequest())) return;
    setBusy(true);
    setError(undefined);
    try {
      await (requestedAt
        ? api.accountSettings.cancelDeletion()
        : api.accountSettings.requestDeletion());
      const body = await api.accountSettings.deletion();
      setRequestedAt(body.requestedAt);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Delete account"
      description="Request permanent deletion of your login and account after a 30-day waiting period."
    >
      <p>
        Your account stays active until it is purged. Leave or delete your
        organizations first; active memberships, admin access, or retained
        audit, financial, and contract records can prevent deletion.
        Organization records are managed separately.
      </p>
      {requestedAt && (
        <p>
          Deletion requested: {new Date(requestedAt).toLocaleDateString()}. You
          can cancel until the account is purged.
        </p>
      )}
      {error && <Toast tone="danger">{error}</Toast>}
      <Button
        busy={busy}
        disabled={busy || requestedAt === undefined}
        onClick={() => void update()}
      >
        {requestedAt ? "Cancel deletion request" : "Request account deletion"}
      </Button>
    </Card>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not load the deletion request.";
}

function confirmDeletionRequest() {
  return confirmDialog({
    confirmLabel: "Request deletion",
    message: "You can cancel here before your account is purged.",
    title: "Permanently delete your account after 30 days?",
    tone: "danger",
  });
}
