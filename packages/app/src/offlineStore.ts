import type { AuditTemplate } from "@balebase/validators/audits";
import type { IssueMember } from "@balebase/validators/issues";
import type {
  OfflineOperation,
  OfflineScope,
} from "@balebase/validators/offline";
import { apiUrl } from "./config";

export interface OfflineAudit {
  id: string;
  startedAt: string;
  template: AuditTemplate;
  responses: Record<string, string>;
  queued: boolean;
}

interface OfflineIssue {
  operation: Extract<OfflineOperation, { type: "issue" }>;
  images: { id: string; filename: string }[];
}

export interface OfflineJob {
  id: string;
  dependsOn: string[];
  operation:
    | OfflineOperation
    | { type: "image"; issueId: string; id: string; filename: string };
  status: "pending" | "blocked" | "synced";
  attempts: number;
  retryAt: number;
  error?: string;
}

/** Who offline work belongs to, and the organization it was prepared in. */
export interface OfflineIdentity {
  scope: OfflineScope;
  user: IssueMember;
  organizationName: string;
}

export interface OfflineWorkspace extends OfflineIdentity {
  key: string;
  templates: AuditTemplate[];
  members: IssueMember[];
  audits: OfflineAudit[];
  issues: OfflineIssue[];
  jobs: OfflineJob[];
}

const activeKey = `balebase:offline:${apiUrl}`;
let localAccessEpoch = 0;
export const offlineChanged = "balebase:offline-changed";

export function offlineScopeKey(scope: OfflineScope) {
  return JSON.stringify([apiUrl, scope.userId, scope.organizationId]);
}

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("balebase-offline", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("workspaces", { keyPath: "key" });
      request.result.createObjectStore("images");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other app tabs to enable offline storage."));
  });
}

export async function readOfflineWorkspace(key: string) {
  const db = await database();
  try {
    return await new Promise<OfflineWorkspace | undefined>(
      (resolve, reject) => {
        const request = db
          .transaction("workspaces")
          .objectStore("workspaces")
          .get(key);
        request.onsuccess = () =>
          resolve(request.result as OfflineWorkspace | undefined);
        request.onerror = () => reject(request.error);
      },
    );
  } finally {
    db.close();
  }
}

/** Resolve only after commit: a quota error must never look like a saved draft. */
export async function changeOfflineWorkspace(
  key: string,
  change: (workspace: OfflineWorkspace | undefined) => OfflineWorkspace,
  images: { id: string; file: Blob }[] = [],
) {
  const db = await database();
  try {
    const result = await new Promise<OfflineWorkspace>((resolve, reject) => {
      const transaction = db.transaction(
        ["workspaces", "images"],
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore("workspaces");
      let next: OfflineWorkspace;
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          next = change(request.result as OfflineWorkspace | undefined);
          store.put(next);
          for (const image of images)
            transaction.objectStore("images").put(image.file, [key, image.id]);
        } catch (cause) {
          transaction.abort();
          reject(cause);
        }
      };
      transaction.oncomplete = () => resolve(next);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Could not save offline work. Check device storage."),
        );
      transaction.onerror = () => reject(transaction.error);
    });
    window.dispatchEvent(new window.Event(offlineChanged));
    return result;
  } finally {
    db.close();
  }
}

export async function offlineImage(key: string, id: string) {
  const db = await database();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const request = db
        .transaction("images")
        .objectStore("images")
        .get([key, id]);
      request.onsuccess = () =>
        request.result instanceof Blob
          ? resolve(request.result)
          : reject(new Error("The saved image is missing. Sync is paused."));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function activeOfflineKey() {
  try {
    return localStorage.getItem(activeKey);
  } catch {
    return null;
  }
}

export function offlineAccessEpoch() {
  let sharedEpoch: string | null = null;
  try {
    sharedEpoch = localStorage.getItem(`${activeKey}:epoch`);
  } catch {
    /* Storage failures are reported when saving. */
  }
  return JSON.stringify([sharedEpoch, localAccessEpoch]);
}

export function activateOfflineWorkspace(
  key: string,
  epoch = offlineAccessEpoch(),
) {
  if (epoch !== offlineAccessEpoch())
    throw new Error(
      "The active account changed. Reopen Offline work before downloading.",
    );
  localStorage.setItem(activeKey, key);
  window.dispatchEvent(new window.Event(offlineChanged));
}

/** Session changes can also arrive through sign-in or another tab. */
export function lockOtherOfflineWorkspace(
  userId: string,
  organizationId: string | undefined,
) {
  const key = activeOfflineKey();
  if (!key) return;
  try {
    const scope: unknown = JSON.parse(key);
    if (
      Array.isArray(scope) &&
      scope[0] === apiUrl &&
      scope[1] === userId &&
      (!organizationId || scope[2] === organizationId)
    )
      return;
  } catch {
    // An unreadable pointer must not unlock another account's data.
  }
  lockOfflineWorkspace();
}

/** Hides downloaded data on sign-out/account changes without deleting unsynced work. */
export function lockOfflineWorkspace() {
  localAccessEpoch += 1;
  try {
    localStorage.removeItem(activeKey);
    localStorage.setItem(`${activeKey}:epoch`, crypto.randomUUID());
  } catch {
    /* Signing out must still work when storage is full or disabled. */
  }
  window.dispatchEvent(new window.Event(offlineChanged));
}
