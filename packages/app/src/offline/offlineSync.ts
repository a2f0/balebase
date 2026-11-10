import { ApiError } from "@balebase/api-client";
import type { OfflineAuditState } from "@balebase/validators/offline";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { isOnline } from "../shared/network";
import { auditWrites, pushDue } from "./offlineAuditState";
import {
  activeOfflineKey,
  changeOfflineWorkspace,
  type OfflineJob,
  type OfflineWorkspace,
  offlineImage,
  readOfflineWorkspace,
} from "./offlineStore";
import { applyOfflineAuditEvent } from "./offlineWork";

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
        if (await queueDuePush(key, workspace)) continue;
        const job = readyOfflineJob(workspace, Date.now());
        if (!job || !(await syncJob(key, workspace, job))) return true;
      }
      return true;
    },
  );
}

/** Sends one job and records the result; resolves whether others may follow. */
async function syncJob(
  key: string,
  workspace: OfflineWorkspace,
  job: OfflineJob,
) {
  try {
    const audit = await send(workspace, job);
    await recordResult(key, job.id, undefined, audit);
    return true;
  } catch (cause) {
    await recordResult(key, job.id, cause);
    // Connectivity and auth affect every job. A content rejection only
    // blocks its dependents; unrelated work can continue.
    return (
      cause instanceof ApiError &&
      ![401, 403, 408, 429].includes(cause.status) &&
      cause.status < 500
    );
  }
}

/**
 * Puts the answers given since a shared audit's last write into one save,
 * made here so no save is in flight while it takes them. Resolves whether
 * an audit had any due.
 */
async function queueDuePush(key: string, workspace: OfflineWorkspace) {
  const due = workspace.audits.find((audit) =>
    pushDue(audit, auditWrites(workspace.jobs, audit.id)),
  );
  if (!due) return false;
  await changeOfflineWorkspace(key, (current) => {
    if (!current) throw new Error("Offline workspace is missing.");
    return applyOfflineAuditEvent(current, due.id, {
      saveId: crypto.randomUUID(),
      type: "pushed",
    });
  });
  return true;
}

/** Sends a job; an audit write resolves the server's copy of the audit. */
async function send(
  workspace: OfflineWorkspace,
  job: OfflineJob,
): Promise<OfflineAuditState | undefined> {
  const operation = job.operation;
  if (operation.type !== "image")
    return (await api.offline.apply(workspace.scope, operation)).audit;
  const blob = await offlineImage(workspace.key, operation.id);
  const file = new File([blob], operation.filename, { type: blob.type });
  await api.offline.uploadImage(
    workspace.scope,
    operation.issueId,
    operation.id,
    file,
  );
  return undefined;
}

async function recordResult(
  key: string,
  id: string,
  cause?: unknown,
  audit?: OfflineAuditState,
) {
  await changeOfflineWorkspace(key, (workspace) => {
    if (!workspace) throw new Error("Offline workspace is missing.");
    const job = workspace.jobs.find((entry) => entry.id === id);
    if (!job) return workspace;
    if (cause === undefined) {
      job.status = "synced";
      delete job.error;
      // The device takes the server's copy along with its write's outcome.
      if (audit && workspace.audits.some((entry) => entry.id === audit.id))
        return applyOfflineAuditEvent(workspace, audit.id, {
          job: job.id,
          state: audit,
          type: "confirmed",
        });
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
