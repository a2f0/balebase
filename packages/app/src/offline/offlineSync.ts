import { ApiError } from "@balebase/api-client";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { isOnline } from "../shared/network";
import {
  activeOfflineKey,
  changeOfflineWorkspace,
  type OfflineJob,
  type OfflineWorkspace,
  offlineImage,
  readOfflineWorkspace,
} from "./offlineStore";

function readyOfflineJob(workspace: OfflineWorkspace, now: number) {
  return workspace.jobs.find(
    (job) =>
      job.status === "pending" &&
      job.retryAt <= now &&
      job.dependsOn.every((id) =>
        workspace.jobs.some(
          (dependency) =>
            dependency.id === id && dependency.status === "synced",
        ),
      ),
  );
}

/**
 * Locks span tabs; server receipts are still authoritative after a crash.
 * Resolves whether this call drained the queue: false when it was skipped
 * (offline, another workspace, or another drain holding the lock).
 */
export async function syncOfflineWorkspace(key: string): Promise<boolean> {
  if (!isOnline() || activeOfflineKey() !== key) return false;
  if (!navigator.locks) return false; // Supported shells provide Web Locks; never race an unguarded drain.
  return navigator.locks.request(
    `balebase-sync:${key}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return false;
      while (isOnline() && activeOfflineKey() === key) {
        const workspace = await readOfflineWorkspace(key);
        if (!workspace) return true;
        const job = readyOfflineJob(workspace, Date.now());
        if (!job) return true;
        try {
          await send(workspace, job);
          await recordResult(key, job.id);
        } catch (cause) {
          await recordResult(key, job.id, cause);
          // Connectivity and auth affect every job. A content rejection only
          // blocks its dependents; unrelated work can continue.
          if (
            !(cause instanceof ApiError) ||
            [401, 403, 408, 429].includes(cause.status) ||
            cause.status >= 500
          )
            return true;
        }
      }
      return true;
    },
  );
}

async function send(workspace: OfflineWorkspace, job: OfflineJob) {
  const operation = job.operation;
  if (operation.type !== "image") {
    await api.offline.apply(workspace.scope, operation);
    return;
  }
  const blob = await offlineImage(workspace.key, operation.id);
  const file = new File([blob], operation.filename, { type: blob.type });
  await api.offline.uploadImage(
    workspace.scope,
    operation.issueId,
    operation.id,
    file,
  );
}

async function recordResult(key: string, id: string, cause?: unknown) {
  await changeOfflineWorkspace(key, (workspace) => {
    if (!workspace) throw new Error("Offline workspace is missing.");
    const job = workspace.jobs.find((entry) => entry.id === id);
    if (!job) return workspace;
    if (cause === undefined) {
      job.status = "synced";
      delete job.error;
    } else {
      job.attempts += 1;
      const blocked =
        cause instanceof ApiError &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status);
      job.status = blocked ? "blocked" : "pending";
      job.retryAt =
        Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 9));
      job.error = errorMessage(
        cause,
        "Could not sync. Your work is saved on this device.",
      );
    }
    return workspace;
  });
}
