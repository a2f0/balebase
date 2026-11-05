import type {
  FinanceData,
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { apiUrl } from "../shared/config";

/** Whose transactions a device keeps: one person in one organization. */
export interface CacheScope {
  organizationId: string;
  userId: string;
}

export type FinanceSummary = Omit<FinanceData, "nextCursor" | "transactions">;

/** What this device keeps for a scope. */
interface CachedFinance {
  /** The feed cursor the transactions are as of; null before any page. */
  cursor: string | null;
  /** When a pull last caught up with the server; none before the first. */
  completedAt: string | null;
  /** Connections, accounts, and categories as last read online. */
  summary: FinanceSummary | null;
  transactions: FinanceTransaction[];
}

interface CacheState {
  completedAt: string | null;
  cursor: string | null;
  scope: string;
  summary: FinanceSummary | null;
}

/**
 * Where a pull stands: the kept cursor, and the epoch, which signing out
 * (for the person) or a refusal (for the scope) advances so nothing
 * requested before it is kept after.
 */
interface Position {
  cursor: string | null;
  epoch: string;
}

/** Raised for a response from another organization than the scope's. */
export class OrganizationChanged extends Error {
  constructor() {
    super("The active organization changed. Reload Finance.");
  }
}

/** Raised for a write that arrives after its saved copy was cleared. */
export class SignedOut extends Error {
  constructor() {
    super("Saved transactions were cleared. Reload Finance.");
  }
}

/** Where a device keeps transactions: IndexedDB, or memory without it. */
export interface TransactionStore {
  read(scope: CacheScope): Promise<CachedFinance>;
  position(scope: CacheScope): Promise<Position>;
  /**
   * Applies one feed page, with its cursor, in one write, if the kept cursor
   * is still `from`'s. False when another pull (another tab) moved it first;
   * `SignedOut` when the person signed out since `from` was read.
   */
  apply(
    scope: CacheScope,
    from: Position,
    page: FinanceTransactionChanges,
    now: string,
  ): Promise<boolean>;
  /** Keeps the summary, unless the copy was cleared since `epoch`. */
  saveSummary(
    scope: CacheScope,
    summary: FinanceSummary,
    epoch: string,
  ): Promise<void>;
  /** Starts the copy over for a server that is behind it. */
  restart(scope: CacheScope, from: Position): Promise<void>;
  /** Drops the copy after a refusal, ending pulls still running. */
  clear(scope: CacheScope): Promise<void>;
}

const databaseName = "balebase-finance";

function scopeKey(scope: CacheScope) {
  return JSON.stringify([apiUrl, scope.userId, scope.organizationId]);
}

/** The state key holding a person's epoch, beside their scopes' keys. */
function epochKey(userId: string) {
  return JSON.stringify([apiUrl, userId]);
}

/** The state key holding a scope's epoch. */
function scopeEpochKey(scope: CacheScope) {
  return JSON.stringify([apiUrl, scope.userId, scope.organizationId, "epoch"]);
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
export function memoryTransactionStore(): TransactionStore {
  const scopes = new Map<
    string,
    { rows: Map<string, FinanceTransaction>; state: CacheState }
  >();
  const epochs = new Map<string, number>();
  const epochOf = (scope: CacheScope) =>
    String(epochs.get(scopeKey(scope)) ?? 0);
  const check = (scope: CacheScope, epoch: string) => {
    if (epoch !== epochOf(scope)) throw new SignedOut();
  };
  const entry = (scope: CacheScope) => {
    const key = scopeKey(scope);
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
      return { cursor: entry(scope).state.cursor, epoch: epochOf(scope) };
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
      scopes.delete(scopeKey(scope));
    },
    async clear(scope) {
      scopes.delete(scopeKey(scope));
      epochs.set(scopeKey(scope), Number(epochOf(scope)) + 1);
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
async function readEpoch(store: IDBObjectStore, scope: CacheScope) {
  const [person, own] = await Promise.all([
    readEpochRecord(store, epochKey(scope.userId)),
    readEpochRecord(store, scopeEpochKey(scope)),
  ]);
  return `${person}:${own}`;
}

async function checkEpoch(
  store: IDBObjectStore,
  scope: CacheScope,
  epoch: string,
) {
  if ((await readEpoch(store, scope)) !== epoch) throw new SignedOut();
}

function deleteScope(store: IDBObjectStore, key: string) {
  return request(store.index("scope").getAllKeys(IDBKeyRange.only(key))).then(
    (keys) => {
      for (const found of keys) store.delete(found);
    },
  );
}

export function indexedDbTransactionStore(): TransactionStore {
  return {
    read(scope) {
      const key = scopeKey(scope);
      return inTransaction("readonly", async (stores) => {
        const [state, rows] = await Promise.all([
          readState(stores.state, key),
          request(
            stores.transactions.index("scope").getAll(IDBKeyRange.only(key)),
          ),
        ]);
        return {
          completedAt: state.completedAt,
          cursor: state.cursor,
          summary: state.summary,
          transactions: (rows as { transaction: FinanceTransaction }[]).map(
            (row) => row.transaction,
          ),
        };
      });
    },
    position(scope) {
      return inTransaction("readwrite", async (stores) => {
        const [state, epoch] = await Promise.all([
          readState(stores.state, scopeKey(scope)),
          readEpoch(stores.state, scope),
        ]);
        // Registers the scope before anything is requested for it, so
        // clearing a former organization finds (and ends) a pull still
        // waiting on its first page.
        stores.state.put(state);
        return { cursor: state.cursor, epoch };
      });
    },
    apply(scope, from, page, now) {
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(stores.state, scope, from.epoch);
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
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(stores.state, scope, epoch);
        const state = await readState(stores.state, key);
        stores.state.put({ ...state, summary });
      });
    },
    restart(scope, from) {
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        await checkEpoch(stores.state, scope, from.epoch);
        stores.state.delete(key);
        await deleteScope(stores.transactions, key);
      });
    },
    clear: clearScopeTransactions,
  };
}

/**
 * Drops what this device keeps for a scope, as after a refusal, and advances
 * its epoch so pulls still running (in any tab) keep nothing they receive.
 */
export async function clearScopeTransactions(scope: CacheScope) {
  if (typeof indexedDB === "undefined") return;
  const key = scopeKey(scope);
  await inTransaction("readwrite", async (stores) => {
    stores.state.delete(key);
    await deleteScope(stores.transactions, key);
    stores.state.put({
      epoch: crypto.randomUUID(),
      scope: scopeEpochKey(scope),
    });
  });
}

/**
 * Drops what this device keeps for a person in organizations they are no
 * longer in, as after leaving or being removed from one.
 */
export async function clearFormerOrganizations(
  userId: string,
  organizationIds: string[],
) {
  if (typeof indexedDB === "undefined") return;
  const current = new Set(organizationIds);
  await inTransaction("readwrite", async (stores) => {
    const keys = (await request(stores.state.getAllKeys())) as string[];
    for (const key of keys) {
      const [api, owner, organizationId, kind] = JSON.parse(key) as unknown[];
      if (
        api !== apiUrl ||
        owner !== userId ||
        typeof organizationId !== "string" ||
        kind !== undefined ||
        current.has(organizationId)
      )
        continue;
      stores.state.delete(key);
      await deleteScope(stores.transactions, key);
      stores.state.put({
        epoch: crypto.randomUUID(),
        scope: scopeEpochKey({ organizationId, userId }),
      });
    }
  });
}

/**
 * Drops everything this device keeps for a person, in every organization, as
 * on signing out, and advances their epoch so pulls still running (in any
 * tab) keep none of the pages they receive. Other accounts keep theirs.
 */
export async function clearUserTransactions(userId: string) {
  if (typeof indexedDB === "undefined") return;
  await inTransaction("readwrite", async (stores) => {
    const keys = (await request(stores.state.getAllKeys())) as string[];
    for (const key of keys) {
      const [api, owner, organizationId] = JSON.parse(key) as unknown[];
      if (api !== apiUrl || owner !== userId || organizationId === undefined)
        continue;
      stores.state.delete(key);
      await deleteScope(stores.transactions, key);
    }
    stores.state.put({ epoch: crypto.randomUUID(), scope: epochKey(userId) });
  });
}

/** Pulls running, per store and scope: a store abandoned mid-pull is not shared. */
const pulls = new WeakMap<TransactionStore, Map<string, Promise<void>>>();

/**
 * Brings the kept transactions up to date, a page at a time. Each page and
 * its cursor are written together, so an interrupted pull (a closed tab, a
 * lost connection) resumes from the last saved page. Tabs share the work
 * through a Web Lock where the browser has one; otherwise the cursor check
 * in `apply` keeps two pulls from overwriting each other.
 */
export function pullTransactions(
  scope: CacheScope,
  store: TransactionStore,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  onProgress?: (saved: number) => void,
  /** Keep pages of whichever organization answers (no known scope). */
  anyOrganization = false,
) {
  const key = scopeKey(scope);
  let running = pulls.get(store);
  if (!running) {
    running = new Map();
    pulls.set(store, running);
  }
  const shared = running.get(key);
  if (shared) return shared;
  const work = withLock(`${databaseName}:${key}`, () =>
    pullPages(scope, store, fetchPage, onProgress, anyOrganization),
  ).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

async function pullPages(
  scope: CacheScope,
  store: TransactionStore,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  onProgress: ((saved: number) => void) | undefined,
  anyOrganization: boolean,
) {
  let saved = 0;
  let reset = false;
  // Pinned: a sign-out during the pull ends it rather than restarting it.
  const { epoch } = await store.position(scope);
  for (;;) {
    const from = { cursor: (await store.position(scope)).cursor, epoch };
    const page = await fetchPage(from.cursor);
    // The session's organization changed under this pull.
    if (!anyOrganization && page.organizationId !== scope.organizationId)
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
 * Brings a saved copy up to date after a change made away from the overview
 * (a transaction's page), so the change outlasts going offline. Nothing
 * happens without a saved copy; failures wait for the next load.
 */
export async function catchUpSavedTransactions(
  scope: CacheScope | undefined,
  fetchPage: (cursor: string | null) => Promise<FinanceTransactionChanges>,
  store: TransactionStore | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDbTransactionStore(),
) {
  if (!scope || !store) return;
  try {
    if ((await store.position(scope)).cursor === null) return;
    await pullTransactions(scope, store, fetchPage);
  } catch {
    // The next load catches up instead.
  }
}

function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(name, work) : work();
}
