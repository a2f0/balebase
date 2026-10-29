import { Button, Card, confirmDialog, Toast } from "@balebase/ui/react";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";

const loadRequestedAt = async () =>
  (await api.accountSettings.deletion()).requestedAt;

export function AccountDeletion() {
  const loaded = useLoad(
    loadRequestedAt,
    "Could not load the deletion request.",
  );
  const requestedAt = loaded.data;
  const action = useAction("Could not update the deletion request.");
  const { busy } = action;
  const error = action.error ?? loaded.error;

  async function update() {
    if (!requestedAt && !(await confirmDeletionRequest())) return;
    await action.run(async () => {
      await (requestedAt
        ? api.accountSettings.cancelDeletion()
        : api.accountSettings.requestDeletion());
      loaded.setData(await loadRequestedAt());
    });
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

function confirmDeletionRequest() {
  return confirmDialog({
    confirmLabel: "Request deletion",
    message: "You can cancel here before your account is purged.",
    title: "Permanently delete your account after 30 days?",
    tone: "danger",
  });
}
