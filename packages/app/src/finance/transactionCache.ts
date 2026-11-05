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

/** Where a device keeps transactions: IndexedDB, or memory without it. */
export interface TransactionStore {
  read(scope: CacheScope): Promise<CachedFinance>;
  cursor(scope: CacheScope): Promise<string | null>;
  /**
   * Applies one feed page, with its cursor, in one write, if the kept cursor
   * is still `from`. False when another pull (another tab) moved it first.
   */
  apply(
    scope: CacheScope,
    from: string | null,
    page: FinanceTransactionChanges,
    now: string,
  ): Promise<boolean>;
  saveSummary(scope: CacheScope, summary: FinanceSummary): Promise<void>;
  clear(scope: CacheScope): Promise<void>;
}

const databaseName = "balebase-finance";

function scopeKey(scope: CacheScope) {
  return JSON.stringify([apiUrl, scope.userId, scope.organizationId]);
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
    async cursor(scope) {
      return entry(scope).state.cursor;
    },
    async apply(scope, from, page, now) {
      const found = entry(scope);
      if (found.state.cursor !== from) return false;
      for (const transaction of page.transactions)
        found.rows.set(transaction.id, transaction);
      for (const id of page.removedIds) found.rows.delete(id);
      found.state = nextState(found.state, page, now);
      return true;
    },
    async saveSummary(scope, summary) {
      const found = entry(scope);
      found.state = { ...found.state, summary };
    },
    async clear(scope) {
      scopes.delete(scopeKey(scope));
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
    cursor(scope) {
      return inTransaction("readonly", async (stores) => {
        return (await readState(stores.state, scopeKey(scope))).cursor;
      });
    },
    apply(scope, from, page, now) {
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        const state = await readState(stores.state, key);
        if (state.cursor !== from) return false;
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
    saveSummary(scope, summary) {
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        const state = await readState(stores.state, key);
        stores.state.put({ ...state, summary });
      });
    },
    clear(scope) {
      const key = scopeKey(scope);
      return inTransaction("readwrite", async (stores) => {
        stores.state.delete(key);
        await deleteScope(stores.transactions, key);
      });
    },
  };
}

/**
 * Drops everything this device keeps for a person, in every organization, as
 * on signing out. Other signed-in accounts keep theirs.
 */
export async function clearUserTransactions(userId: string) {
  if (typeof indexedDB === "undefined") return;
  await inTransaction("readwrite", async (stores) => {
    const keys = (await request(stores.state.getAllKeys())) as string[];
    for (const key of keys) {
      const [api, owner] = JSON.parse(key) as unknown[];
      if (api !== apiUrl || owner !== userId) continue;
      stores.state.delete(key);
      await deleteScope(stores.transactions, key);
    }
  });
}

const pulls = new Map<string, Promise<void>>();

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
  const running = pulls.get(key);
  if (running) return running;
  const work = withLock(`${databaseName}:${key}`, () =>
    pullPages(scope, store, fetchPage, onProgress, anyOrganization),
  ).finally(() => pulls.delete(key));
  pulls.set(key, work);
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
  for (;;) {
    const from = await store.cursor(scope);
    const page = await fetchPage(from);
    // The session's organization changed under this pull.
    if (!anyOrganization && page.organizationId !== scope.organizationId)
      throw new Error("The active organization changed. Reload Finance.");
    if (page.reset) {
      if (reset) throw new Error("Could not read transactions. Try again.");
      reset = true;
      await store.clear(scope);
      continue;
    }
    if (await store.apply(scope, from, page, new Date().toISOString())) {
      saved += page.transactions.length;
      if (page.transactions.length) onProgress?.(saved);
      if (!page.more) return;
    }
  }
}

function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(name, work) : work();
}
