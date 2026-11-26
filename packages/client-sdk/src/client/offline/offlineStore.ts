import type { OfflineScope } from "@balebase/validators/offline";
import type {
  OfflineIdentity,
  OfflineWorkspace,
} from "../../data/offline/offlineWorkspace";

// Devices hold unsynced work under these names, versions, and key shapes;
// changing any of them strands it.
const databaseName = "balebase-offline";
const databaseVersion = 5;

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      // Each version starts empty; nothing from an earlier one is kept.
      for (const name of Array.from(request.result.objectStoreNames))
        request.result.deleteObjectStore(name);
      request.result.createObjectStore("workspaces", { keyPath: "key" });
      request.result.createObjectStore("images");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other app tabs to enable offline storage."));
  });
}

/**
 * What every store for one API in this tab shares, as they share the
 * device's storage: how often the tab locked, and who hears of changes. A
 * second SDK, as when a host changes, neither unlocks what the first locked
 * nor leaves the first's subscribers deaf.
 */
interface TabState {
  locks: number;
  listeners: Set<() => void>;
}
const tabs = new Map<string, TabState>();

function tabState(pointer: string) {
  let state = tabs.get(pointer);
  if (!state) {
    state = { locks: 0, listeners: new Set() };
    tabs.set(pointer, state);
  }
  return state;
}

/**
 * The device's offline workspaces in IndexedDB, one per person and
 * organization, and which one is active: a pointer in localStorage that
 * signing out or switching accounts clears, hiding downloaded data without
 * deleting unsynced work. Workspaces are kept per API origin.
 */
export class OfflineStore {
  readonly #apiBaseUrl: string;
  readonly #activeKey: string;
  readonly #tab: TabState;

  constructor(apiBaseUrl: string) {
    this.#apiBaseUrl = apiBaseUrl;
    this.#activeKey = `balebase:offline:${apiBaseUrl}`;
    this.#tab = tabState(this.#activeKey);
  }

  /**
   * Calls `listener` after each change made in this tab, by any store for
   * this API; returns an unsubscribe.
   */
  subscribe(listener: () => void) {
    this.#tab.listeners.add(listener);
    return () => {
      this.#tab.listeners.delete(listener);
    };
  }

  /**
   * Tells every listener, reporting rather than raising what one throws:
   * the change is made by then, and a save or sign-out must not look failed.
   */
  #notify() {
    for (const listener of [...this.#tab.listeners]) {
      try {
        listener();
      } catch (cause) {
        reportError(cause);
      }
    }
  }

  scopeKey(scope: OfflineScope) {
    return JSON.stringify([
      this.#apiBaseUrl,
      scope.userId,
      scope.organizationId,
    ]);
  }

  /** A new, empty workspace for `identity`. */
  emptyWorkspace(identity: OfflineIdentity): OfflineWorkspace {
    return {
      ...identity,
      key: this.scopeKey(identity.scope),
      projects: [],
      templates: [],
      members: [],
      forms: [],
      issues: [],
      jobs: [],
    };
  }

  async read(key: string) {
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
  async change(
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
              transaction
                .objectStore("images")
                .put(image.file, [key, image.id]);
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
      this.#notify();
      return result;
    } finally {
      db.close();
    }
  }

  async image(key: string, id: string) {
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

  /** The active workspace's key, or null while none is unlocked. */
  activeKey() {
    try {
      return localStorage.getItem(this.#activeKey);
    } catch {
      return null;
    }
  }

  /**
   * Changes when any tab locks the device or this one does. Work that
   * confirmed an identity at one epoch stops once it moves on.
   */
  accessEpoch() {
    let sharedEpoch: string | null = null;
    try {
      sharedEpoch = localStorage.getItem(`${this.#activeKey}:epoch`);
    } catch {
      /* Storage failures are reported when saving. */
    }
    return JSON.stringify([sharedEpoch, this.#tab.locks]);
  }

  activate(key: string, epoch = this.accessEpoch()) {
    if (epoch !== this.accessEpoch())
      throw new Error("The active account changed. Reload before syncing.");
    localStorage.setItem(this.#activeKey, key);
    this.#notify();
  }

  /**
   * Locks the device unless the active workspace is this person's (in this
   * organization, when given). Session changes can also arrive through
   * sign-in or another tab.
   */
  lockOther(userId: string, organizationId: string | undefined) {
    const key = this.activeKey();
    if (!key) return;
    try {
      const scope: unknown = JSON.parse(key);
      if (
        Array.isArray(scope) &&
        scope[0] === this.#apiBaseUrl &&
        scope[1] === userId &&
        (!organizationId || scope[2] === organizationId)
      )
        return;
    } catch {
      // An unreadable pointer must not unlock another account's data.
    }
    this.lock();
  }

  /** Hides downloaded data on sign-out/account changes without deleting unsynced work. */
  lock() {
    this.#tab.locks += 1;
    try {
      localStorage.removeItem(this.#activeKey);
      localStorage.setItem(`${this.#activeKey}:epoch`, crypto.randomUUID());
    } catch {
      /* Signing out must still work when storage is full or disabled. */
    }
    this.#notify();
  }
}
