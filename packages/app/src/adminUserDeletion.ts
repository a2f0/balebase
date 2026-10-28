import { ApiError } from "@balebase/api-client";
import { confirmDialog } from "@balebase/ui/react";
import type { AdminUser } from "@balebase/validators/adminUsers";
import { useState } from "react";
import { api } from "./apiClient";
import { errorMessage } from "./errors";

export function useAdminUserDeletion(reload: () => Promise<void>) {
  const [userId, setUserId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function update(user: AdminUser) {
    if (!(await confirmUserDeletion(user))) return;
    setUserId(user.id);
    setError(undefined);
    setNotice(undefined);
    try {
      if (user.deletionRequestedAt) {
        await api.adminUsers.cancelDeletion(user.id);
        setNotice(`Deletion canceled for ${user.email}.`);
      } else {
        await api.adminUsers.markForDeletion(user.id, user.email);
        setNotice(`${user.email} was marked for deletion.`);
      }
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Could not update user deletion."));
      if (cause instanceof ApiError && cause.status === 409) await reload();
    } finally {
      setUserId(undefined);
    }
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
