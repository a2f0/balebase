import { confirmDialog } from "@balebase/ui/react";
import type { FinanceSyncJob } from "@balebase/validators/finance";

/** The part of a connection its confirmations name. */
interface Institution {
  institutionName: string | null;
}

export function syncPending(status: string | null | undefined) {
  return status === "queued" || status === "running";
}

export function syncNotice(result: FinanceSyncJob) {
  if (syncPending(result.status))
    return "Sync queued. You can leave this page; syncing will continue in the background.";
  return `Sync complete: ${result.added} added, ${result.modified} updated, ${result.removed} removed.`;
}

export function confirmDataDeletion(connection: Institution) {
  return confirmDialog({
    confirmLabel: "Delete data",
    message:
      "This also deletes its transaction annotations and cannot be undone.",
    title: `Permanently delete all imported data for ${institutionName(connection)}?`,
    tone: "danger",
  });
}

export function confirmDisconnect(connection: Institution) {
  return confirmDialog({
    confirmLabel: "Disconnect",
    message:
      "Plaid access will be revoked and waiting syncs cancelled. Imported transactions and annotations will remain.",
    title: `Disconnect ${institutionName(connection)}?`,
    tone: "danger",
  });
}

function institutionName(connection: Institution) {
  return connection.institutionName ?? "this institution";
}
