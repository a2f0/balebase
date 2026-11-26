import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import {
  type CacheScope,
  type Cleared,
  type FinanceSummary,
  OrganizationChanged,
  refused,
  SignedOut,
  type TransactionStore,
  withTimeout,
} from "../../data/finance/financeCache";
import { savedSummary } from "../../data/finance/savedSummary";
import { randomId } from "../../data/shared/randomId";

interface CacheState {
  completedAt: string | null;
  cursor: string | null;
  scope: string;
  summary: FinanceSummary | null;
}

// Devices keep transactions under these names and key shapes, and tabs of
// other releases announce clearings on this channel; changing them strands
// saved copies or leaves another tab showing what was cleared.
const databaseName = "balebase-finance";

function scopeKey(apiBaseUrl: string, scope: CacheScope) {
  return JSON.stringify([apiBaseUrl, scope.userId, scope.organizationId]);
}

/** The state key holding a person's epoch, beside their scopes' keys. */
function epochKey(apiBaseUrl: string, userId: string) {
  return JSON.stringify([apiBaseUrl, userId]);
}

/** The state key holding a scope's epoch. */
function scopeEpochKey(apiBaseUrl: string, scope: CacheScope) {
  return JSON.stringify([
    apiBaseUrl,
    scope.userId,
    scope.organizationId,
    "epoch",
  ]);
}

function emptyState(scope: string): CacheState {
  return { completedAt: null, cursor: null, scope, summary: null };
}

function nextState(
  state: CacheState,
  page: FinanceTransactionChanges,
  now: string,
): CacheState {
  return {
    ...state,
    completedAt: page.more ? state.completedAt : now,
    cursor: page.cursor,
  };
}

/** A store that lasts as long as the page, for browsers without IndexedDB. */
export function memoryTransactionStore(apiBaseUrl: string): TransactionStore {
  const scopes = new Map<
    string,
    { rows: Map<string, FinanceTransaction>; state: CacheState }
  >();
  const epochs = new Map<string, number>();
  const epochOf = (scope: CacheScope) =>
    String(epochs.get(scopeKey(apiBaseUrl, scope)) ?? 0);
  const check = (scope: CacheScope, epoch: string) => {
    if (epoch !== epochOf(scope)) throw new SignedOut();
  };
  const entry = (scope: CacheScope) => {
    const key = scopeKey(apiBaseUrl, scope);
    let found = scopes.get(key);
    if (!found) {
      found = { rows: new Map(), state: emptyState(key) };
      scopes.set(key, found);
    }
    return found;
  };
  return {
    async read(scope) {
      const { rows, state } = entry(scope);
      return { ...state, transactions: [...rows.values()] };
    },
    async position(scope) {
      const { state } = entry(scope);
      return {
        cursor: state.cursor,
        epoch: epochOf(scope),
        saved: state.cursor !== null || state.completedAt !== null,
      };
    },
    async apply(scope, from, page, now) {
      check(scope, from.epoch);
      const found = entry(scope);
      if (found.state.cursor !== from.cursor) return false;
      for (const transaction of page.transactions)
        found.rows.set(transaction.id, transaction);
      for (const id of page.removedIds) found.rows.delete(id);
      found.state = nextState(found.state, page, now);
      return true;
    },
    async saveSummary(scope, summary, epoch) {
      check(scope, epoch);
      const found = entry(scope);
      found.state = { ...found.state, summary };
    },
    async restart(scope, from) {
      check(scope, from.epoch);
      scopes.delete(scopeKey(apiBaseUrl, scope));
    },
    async clear(scope) {
      scopes.delete(scopeKey(apiBaseUrl, scope));
      epochs.set(scopeKey(apiBaseUrl, scope), Number(epochOf(scope)) + 1);
      // Only this tab kept the copy, but what it hides may still show it.
      tellThisTab(apiBaseUrl, scope);
    },
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const transactions = request.result.createObjectStore("transactions", {
        keyPath: ["scope", "id"],
      });
      transactions.createIndex("scope", "scope");
      request.result.createObjectStore("state", { keyPath: "scope" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other app tabs to update saved transactions."));
  });
}

/** Runs `work` in one transaction; resolves after it commits. */
async function inTransaction<T>(
  mode: IDBTransactionMode,
  work: (stores: {
    state: IDBObjectStore;
    transactions: IDBObjectStore;
  }) => Promise<T> | T,
) {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(["state", "transactions"], mode, {
        durability: "strict",
      });
      let result: T;
      Promise.resolve(
        work({
          state: transaction.objectStore("state"),
          transactions: transaction.objectStore("transactions"),
        }),
      ).then(
        (value) => {
          result = value;
        },
        (cause: unknown) => {
          transaction.abort();
          reject(cause);
        },
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Could not save transactions. Check device storage."),
        );
    });
  } finally {
    db.close();
  }
}

function request<T>(target: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

function readState(store: IDBObjectStore, key: string) {
  return request(store.get(key)).then(
    (found) => (found as CacheState | undefined) ?? emptyState(key),
  );
}

function readEpochRecord(store: IDBObjectStore, key: string) {
  return request(store.get(key)).then(
    (found) => (found as { epoch: string } | undefined)?.epoch ?? "",
  );
}

/** The person's epoch with the scope's: either one advancing ends a pull. */
async function readEpoch(
  apiBaseUrl: string,
  store: IDBObjectStore,
  scope: CacheScope,
) {
  const [person, own] = await Promise.all([
    readEpochRecord(store, epochKey(apiBaseUrl, scope.userId)),
    readEpochRecord(store, scopeEpochKey(apiBaseUrl, scope)),
  ]);
  return `${person}:${own}`;
}

async function checkEpoch(
  apiBaseUrl: string,
  store: IDBObjectStore,
  scope: CacheScope,
  epoch: string,
) {
  if ((await readEpoch(apiBaseUrl, store, scope)) !== epoch)
    throw new SignedOut();
}

function deleteScope(store: IDBObjectStore, key: string) {
  return request(store.index("scope").getAllKeys(IDBKeyRange.only(key))).then(
    (keys) => {
      for (const found of keys) store.delete(found);
    },
  );
}

export function indexedDbTransactionStore(
  apiBaseUrl: string,
): TransactionStore {
  return {
    read(scope) {
      const key = scopeKey(apiBaseUrl, scope);
      return inTransaction("readonly", async (stores) => {
        const [state, rows] = await Promise.all([
          readState(stores.state, key),
          request(
            stores.transactions.index("scope").getAll(IDBKeyRange.only(key)),
          ),
        ]);
        const transactions = (
          rows as { transaction: FinanceTransaction }[]
        ).map((row) => row.transaction);
        return {
          completedAt: state.completedAt,
          cursor: state.cursor,
          // A summary saved by an earlier release lacks newer fields.
          summary: savedSummary(state.summary, transactions),
          transactions,
        };
      });
    },
    position(scope) {
      return inTransaction("readwrite", async (stores) => {
        const [state, epoch] = await Promise.all([
          readState(stores.state, scopeKey(apiBaseUrl, scope)),
          readEpoch(apiBaseUrl, stores.state, scope),
        ]);
        // Registers the scope before anything is requested for it, so
        // clearing a former organization finds (and ends) a pull still
        // waiting on its first page.
        stores.state.put(state);
        return {
          cursor: state.cursor,
          epoch,
          saved: state.cursor !== null || state.completedAt !== null,
        };
      });
    },
    apply(scope, from, page, now) {
      const key = scopeKey(apiBaseUrl, scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(apiBaseUrl, stores.state, scope, from.epoch);
        const state = await readState(stores.state, key);
        if (state.cursor !== from.cursor) return false;
        for (const transaction of page.transactions)
          stores.transactions.put({
            id: transaction.id,
            scope: key,
            transaction,
          });
        for (const id of page.removedIds) stores.transactions.delete([key, id]);
        stores.state.put(nextState(state, page, now));
        return true;
      });
    },
    saveSummary(scope, summary, epoch) {
      const key = scopeKey(apiBaseUrl, scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(apiBaseUrl, stores.state, scope, epoch);
        const state = await readState(stores.state, key);
        stores.state.put({ ...state, summary });
      });
    },
    restart(scope, from) {
      const key = scopeKey(apiBaseUrl, scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(apiBaseUrl, stores.state, scope, from.epoch);
        stores.state.delete(key);
        await deleteScope(stores.transactions, key);
      });
    },
    clear: (scope, announce) =>
      clearScopeTransactions(apiBaseUrl, scope, announce),
  };
}

/**
 * Drops what this device keeps for a scope, as after a refusal, and advances
 * its epoch so pulls still running (in any tab) keep nothing they receive.
 */
export async function clearScopeTransactions(
  apiBaseUrl: string,
  scope: CacheScope,
  announce = true,
) {
  if (announce)
    announceCleared(apiBaseUrl, {
      organizationId: scope.organizationId,
      userId: scope.userId,
    });
  if (typeof indexedDB === "undefined") return;
  const key = scopeKey(apiBaseUrl, scope);
  await inTransaction("readwrite", async (stores) => {
    stores.state.delete(key);
    await deleteScope(stores.transactions, key);
    stores.state.put({
      epoch: randomId(),
      scope: scopeEpochKey(apiBaseUrl, scope),
    });
  });
}

/**
 * Drops what this device keeps for a person in organizations they are no
 * longer in, as after leaving or being removed from one.
 */
export async function clearFormerOrganizations(
  apiBaseUrl: string,
  userId: string,
  organizationIds: string[],
) {
  announceCleared(apiBaseUrl, { except: organizationIds, userId });
  if (typeof indexedDB === "undefined") return;
  const current = new Set(organizationIds);
  await inTransaction("readwrite", async (stores) => {
    const keys = (await request(stores.state.getAllKeys())) as string[];
    for (const key of keys) {
      const [api, owner, organizationId, kind] = JSON.parse(key) as unknown[];
      if (
        api !== apiBaseUrl ||
        owner !== userId ||
        typeof organizationId !== "string" ||
        kind !== undefined ||
        current.has(organizationId)
      )
        continue;
      stores.state.delete(key);
      await deleteScope(stores.transactions, key);
      stores.state.put({
        epoch: randomId(),
        scope: scopeEpochKey(apiBaseUrl, { organizationId, userId }),
      });
    }
  });
}

/**
 * Drops everything this device keeps for a person, in every organization, as
 * on signing out, and advances their epoch so pulls still running (in any
 * tab) keep none of the pages they receive. Other accounts keep theirs.
 */
export async function clearUserTransactions(
  apiBaseUrl: string,
  userId: string,
) {
  announceCleared(apiBaseUrl, { userId });
  if (typeof indexedDB === "undefined") return;
  await inTransaction("readwrite", async (stores) => {
    const keys = (await request(stores.state.getAllKeys())) as string[];
    for (const key of keys) {
      const [api, owner, organizationId] = JSON.parse(key) as unknown[];
      if (
        api !== apiBaseUrl ||
        owner !== userId ||
        organizationId === undefined
      )
        continue;
      stores.state.delete(key);
      await deleteScope(stores.transactions, key);
    }
    stores.state.put({
      epoch: randomId(),
      scope: epochKey(apiBaseUrl, userId),
    });
  });
}

const clearedChannel = "balebase-finance-cleared";
// Tabs ignore their own announcements: they handle those where they happen.
const thisTab = randomId();
/**
 * This tab's listeners, per API, for clearings in any tab; see `onCleared`.
 * They belong to the tab, so every cache for one API there shares them.
 */
const clearedHere = new Map<string, Set<(cleared: Cleared) => void>>();

function listenersFor(apiBaseUrl: string) {
  let listeners = clearedHere.get(apiBaseUrl);
  if (!listeners) {
    listeners = new Set();
    clearedHere.set(apiBaseUrl, listeners);
  }
  return listeners;
}

/**
 * Tells other tabs a saved copy was cleared (access ended, a sign-out), so
 * they stop showing the transactions they read before, and this tab too.
 */
function announceCleared(apiBaseUrl: string, cleared: Cleared) {
  tellThisTab(apiBaseUrl, cleared);
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(clearedChannel);
  // Tabs, other releases' included, read the API from `apiUrl`.
  channel.postMessage({ ...cleared, apiUrl: apiBaseUrl, source: thisTab });
  channel.close();
}

/** Tells this tab's `onCleared` listeners of a clearing here. */
function tellThisTab(
  apiBaseUrl: string,
  { except, organizationId, userId }: Cleared,
) {
  for (const listener of [...listenersFor(apiBaseUrl)])
    listener({ except, organizationId, userId });
}

/**
 * Calls `listener` when another tab clears saved transactions; returns how
 * to stop listening.
 */
export function onClearedElsewhere(
  apiBaseUrl: string,
  listener: (cleared: Cleared) => void,
) {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(clearedChannel);
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as
      | (Cleared & { apiUrl?: string; source?: string })
      | null;
    if (message?.apiUrl === apiBaseUrl && message.source !== thisTab)
      listener(message);
  };
  return () => channel.close();
}

/**
 * Calls `listener` when any tab, this one included, clears saved
 * transactions; returns how to stop listening. For what this tab keeps but
 * does not show, which no clearing can reach where it happens.
 */
export function onCleared(
  apiBaseUrl: string,
  listener: (cleared: Cleared) => void,
) {
  const listeners = listenersFor(apiBaseUrl);
  listeners.add(listener);
  const stopElsewhere = onClearedElsewhere(apiBaseUrl, listener);
  return () => {
    listeners.delete(listener);
    stopElsewhere();
  };
}

/**
 * Pulls per store and scope: the one running, and one queued behind it for
 * callers who arrive meanwhile. A store abandoned mid-pull is not shared.
 */
interface Lane {
  current: Promise<void>;
  next?: Promise<void>;
}
const pulls = new WeakMap<TransactionStore, Map<string, Lane>>();

/**
 * Brings the kept transactions up to date, a page at a time. Each page and
 * its cursor are written together, so an interrupted pull (a closed tab, a
 * lost connection) resumes from the last saved page. Tabs share the work
 * through a Web Lock where the browser has one; otherwise the cursor check
 * in `apply` keeps two pulls from overwriting each other.
 */
export function pullTransactions(
  apiBaseUrl: string,
  scope: CacheScope,
  store: TransactionStore,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  onProgress?: (saved: number) => void,
  /** Keep pages of whichever organization answers (no known scope). */
  anyOrganization = false,
): Promise<void> {
  // Pinned when asked for: a sign-out or refusal after this ends the pull,
  // even one still queued behind another or waiting on another tab's lock.
  const epoch = store.position(scope).then((position) => position.epoch);
  // A caller joining a queued pull leaves its own epoch unread.
  epoch.catch(() => undefined);
  return schedule(apiBaseUrl, scope, store, () =>
    pullPages(scope, store, fetchPage, onProgress, anyOrganization, epoch),
  );
}

function schedule(
  apiBaseUrl: string,
  scope: CacheScope,
  store: TransactionStore,
  run: () => Promise<void>,
): Promise<void> {
  const key = scopeKey(apiBaseUrl, scope);
  let lanes = pulls.get(store);
  if (!lanes) {
    lanes = new Map();
    pulls.set(store, lanes);
  }
  const lane = lanes.get(key);
  // A pull already running may have read pages from before the caller's
  // change (a save): wait for it, then read again, once for every caller
  // arriving meanwhile.
  if (lane) {
    lane.next ??= lane.current
      .catch(() => undefined)
      .then(() => schedule(apiBaseUrl, scope, store, run));
    return lane.next;
  }
  const running = lanes;
  const work = withLock(`${databaseName}:${key}`, run).finally(() =>
    running.delete(key),
  );
  running.set(key, { current: work });
  return work;
}

async function pullPages(
  scope: CacheScope,
  store: TransactionStore,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  onProgress: ((saved: number) => void) | undefined,
  anyOrganization: boolean,
  pinned: Promise<string>,
) {
  let saved = 0;
  let reset = false;
  const epoch = await pinned;
  for (;;) {
    const from = { cursor: (await store.position(scope)).cursor, epoch };
    const page = await withTimeout(fetchPage(from.cursor));
    // The session's account or organization changed under this pull (as
    // another tab switching accounts).
    if (
      !anyOrganization &&
      (page.organizationId !== scope.organizationId ||
        page.userId !== scope.userId)
    )
      throw new OrganizationChanged();
    if (page.reset) {
      if (reset) throw new Error("Could not read transactions. Try again.");
      reset = true;
      await store.restart(scope, from);
      continue;
    }
    if (await store.apply(scope, from, page, new Date().toISOString())) {
      saved += page.transactions.length;
      if (page.transactions.length) onProgress?.(saved);
      if (!page.more) return;
    }
  }
}

/**
 * `work`, clearing the scope's saved transactions when the server refuses it
 * (as a record page finding access gone), before reporting the refusal.
 */
export async function clearedOnRefusal<T>(
  scope: CacheScope | undefined,
  work: Promise<T>,
  clear: (scope: CacheScope) => Promise<void>,
): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    // A `SignedOut` request was ended by a clearing already; clearing again
    // would end a newer pull too.
    if (scope && refused(cause) && !(cause instanceof SignedOut))
      await clear(scope).catch(() => undefined);
    throw cause;
  }
}

/**
 * Brings a saved copy up to date after a change made away from the overview
 * (a transaction's page), so the change outlasts going offline. Nothing
 * happens without a saved copy; failures wait for the next load.
 */
export async function catchUpSavedTransactions(
  apiBaseUrl: string,
  scope: CacheScope | undefined,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  store: TransactionStore | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDbTransactionStore(apiBaseUrl),
) {
  if (!scope || !store) return;
  try {
    if (!(await store.position(scope)).saved) return;
    await pullTransactions(apiBaseUrl, scope, store, fetchPage);
  } catch (cause) {
    // Access ended: keep nothing, and tell the page so it shows nothing.
    // Otherwise the next load catches up.
    if (refused(cause)) {
      // A `SignedOut` pull was ended by a clearing already; clearing again
      // would end a newer one too.
      if (!(cause instanceof SignedOut))
        await store.clear(scope).catch(() => undefined);
      throw cause;
    }
  }
}

function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(name, work) : work();
}
