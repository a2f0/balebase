import { ApiError } from "@balebase/api-client";
import type { OfflineFormState } from "@balebase/validators/offline";
import { formWrites, pushDue } from "../../data/offline/offlineFormState";
import type {
  OfflineJob,
  OfflineWorkspace,
} from "../../data/offline/offlineWorkspace";
import { errorMessage } from "../../data/shared/errorMessage";
import type { OfflineRuntime } from "./offlineRuntime";
import { applyOfflineFormEvent } from "./offlineWork";

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
export async function syncOfflineWorkspace(
  runtime: OfflineRuntime,
  key: string,
): Promise<boolean> {
  const { network, store } = runtime;
  if (!network.online || store.activeKey() !== key) return false;
  if (!navigator.locks) return false; // Supported shells provide Web Locks; never race an unguarded drain.
  return navigator.locks.request(
    `balebase-sync:${key}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return false;
      while (network.online && store.activeKey() === key) {
        const workspace = await store.read(key);
        if (!workspace) return true;
        if (await queueDuePush(runtime, key, workspace)) continue;
        const job = readyOfflineJob(workspace, Date.now());
        if (!job || !(await syncJob(runtime, key, workspace, job))) return true;
      }
      return true;
    },
  );
}

/** Sends one job and records the result; resolves whether others may follow. */
async function syncJob(
  runtime: OfflineRuntime,
  key: string,
  workspace: OfflineWorkspace,
  job: OfflineJob,
) {
  try {
    const form = await send(runtime, workspace, job);
    await recordResult(runtime, key, job.id, undefined, form);
    return true;
  } catch (cause) {
    await recordResult(runtime, key, job.id, cause);
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
 * Puts the answers given since a shared form's last write into one save,
 * made here so no save is in flight while it takes them. Resolves whether
 * a form had any due.
 */
async function queueDuePush(
  { store }: OfflineRuntime,
  key: string,
  workspace: OfflineWorkspace,
) {
  const due = workspace.forms.find((form) =>
    pushDue(form, formWrites(workspace.jobs, form.id)),
  );
  if (!due) return false;
  await store.change(key, (current) => {
    if (!current) throw new Error("Offline workspace is missing.");
    return applyOfflineFormEvent(current, due.id, {
      saveId: crypto.randomUUID(),
      type: "pushed",
    });
  });
  return true;
}

/** Sends a job; a form write resolves the server's copy of the form. */
async function send(
  { api, store }: OfflineRuntime,
  workspace: OfflineWorkspace,
  job: OfflineJob,
): Promise<OfflineFormState | undefined> {
  const operation = job.operation;
  if (operation.type !== "image")
    return (await api.offline.apply(workspace.scope, operation)).form;
  const blob = await store.image(workspace.key, operation.id);
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
  { store }: OfflineRuntime,
  key: string,
  id: string,
  cause?: unknown,
  form?: OfflineFormState,
) {
  await store.change(key, (workspace) => {
    if (!workspace) throw new Error("Offline workspace is missing.");
    const job = workspace.jobs.find((entry) => entry.id === id);
    if (!job) return workspace;
    if (cause !== undefined) {
      recordFailure(job, cause);
      return workspace;
    }
    // A write's receipt can outlive its form: the server then answers with
    // no copy, and the write stays unsynced, keeping the answers it carries.
    const { type } = job.operation;
    if ((type === "formStart" || type === "formSave") && !form) {
      job.status = "blocked";
      job.error =
        "This form is no longer on the server. Your local work has been kept.";
      return workspace;
    }
    job.status = "synced";
    delete job.error;
    // The device takes the server's copy along with its write's outcome.
    return form && workspace.forms.some((entry) => entry.id === form.id)
      ? applyOfflineFormEvent(workspace, form.id, {
          job: job.id,
          state: form,
          type: "confirmed",
        })
      : workspace;
  });
}

function recordFailure(job: OfflineJob, cause: unknown) {
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
