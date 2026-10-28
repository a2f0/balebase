import { ApiError } from "@balebase/api-client";
import { confirmDialog } from "@balebase/ui/react";
import type { AdminUser } from "@balebase/validators/adminUsers";
import { useState } from "react";
import { api } from "./apiClient";
import { useAction } from "./useAction";

export function useAdminUserDeletion(reload: () => Promise<unknown>) {
  const [userId, setUserId] = useState<string>();
  const { error, notice, run } = useAction("Could not update user deletion.");

  async function update(user: AdminUser) {
    if (!(await confirmUserDeletion(user))) return;
    setUserId(user.id);
    await run(
      async () => {
        try {
          await (user.deletionRequestedAt
            ? api.adminUsers.cancelDeletion(user.id)
            : api.adminUsers.markForDeletion(user.id, user.email));
        } catch (cause) {
          // A conflict means the list is out of date.
          if (cause instanceof ApiError && cause.status === 409) await reload();
          throw cause;
        }
        await reload();
      },
      user.deletionRequestedAt
        ? `Deletion canceled for ${user.email}.`
        : `${user.email} was marked for deletion.`,
    );
    setUserId(undefined);
  }

  return { userId, error, notice, update };
}

function confirmUserDeletion(user: AdminUser) {
  if (user.deletionRequestedAt) {
    return confirmDialog({
      title: `Cancel deletion for ${user.email}?`,
      message: "This account will be removed from the deletion queue.",
      confirmLabel: "Cancel deletion",
      cancelLabel: "Keep request",
    });
  }
  return confirmDialog({
    title: `Mark ${user.email} for deletion?`,
    message:
      "The account stays active until it can be permanently purged after 30 days. Active organization memberships and retained audit, financial, or contract records can prevent deletion. Organizations and their data are managed separately. The user or a root admin can cancel before the account is purged.",
    confirmLabel: "Mark for deletion",
    tone: "danger",
    typeToConfirm: user.email,
  });
}
