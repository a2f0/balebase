import type {
  FinanceData,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { newestFirst } from "./financeTransactions";
import {
  type CacheScope,
  type FinanceSummary,
  OrganizationChanged,
  pullTransactions,
  refused,
  SignedOut,
  type TransactionStore,
  withTimeout,
} from "./transactionCache";

/** Raised once when a store gives up on IndexedDB for memory. */
class StoreFellBack extends Error {
  constructor(cause: unknown) {
    super("Saved transactions moved to memory.", { cause });
  }
}

/**
 * IndexedDB can be missing in practice (private windows, full storage);
 * after its first failure the page keeps transactions in memory instead.
 * The failing call raises `StoreFellBack` so the caller starts over against
 * memory rather than reading an empty store as if it were current.
 */
export function fallBack(
  primary: TransactionStore,
  secondary: TransactionStore,
): TransactionStore {
  let active = primary;
  async function attempt<T>(run: (store: TransactionStore) => Promise<T>) {
    if (active === secondary) return run(secondary);
    try {
      return await run(primary);
    } catch (cause) {
      // Signing out is not a storage failure.
      if (cause instanceof SignedOut) throw cause;
      active = secondary;
      throw new StoreFellBack(cause);
    }
  }
  return {
    apply: (...args) => attempt((store) => store.apply(...args)),
    // Clearing reaches IndexedDB even after falling back, where what was
    // saved before the fallback (and other tabs' pulls) still is.
    clear: async (...args) => {
      if (active === primary) return attempt((store) => store.clear(...args));
      await primary.clear(...args).catch(() => {
        // Unavailable storage keeps nothing to clear.
      });
      return secondary.clear(...args);
    },
    position: (...args) => attempt((store) => store.position(...args)),
    read: (...args) => attempt((store) => store.read(...args)),
    restart: (...args) => attempt((store) => store.restart(...args)),
    saveSummary: (...args) => attempt((store) => store.saveSummary(...args)),
  };
}

const anyOrganization: CacheScope = { organizationId: "", userId: "" };

/** Drops what `store` keeps for `scope` (or for no known scope). */
export function forgetFinance(
  store: TransactionStore,
  scope: CacheScope | undefined,
  announce = true,
) {
  return store.clear(scope ?? anyOrganization, announce).catch(() => {
    // Unavailable storage keeps nothing to clear.
  });
}

interface LoadSources {
  summary: () => Promise<FinanceData>;
  changes: (cursor: string | null) => Promise<FinanceTransactionChanges>;
  onProgress: (saved: number) => void;
}

/**
 * Finance's data: the summary, with every transaction from `store` brought
 * up to date when `keepTransactions`. Offline, the saved copy (if a pull ever
 * finished) comes with when it was current; a refusal clears it.
 */
export async function loadFinance(
  store: TransactionStore,
  scope: CacheScope | undefined,
  keepTransactions: boolean,
  sources: LoadSources,
) {
  try {
    return await loadOnce(store, scope, keepTransactions, sources);
  } catch (cause) {
    // The store now keeps transactions in memory; download them again.
    if (cause instanceof StoreFellBack)
      return loadOnce(store, scope, keepTransactions, sources);
    throw cause;
  }
}

async function loadOnce(
  store: TransactionStore,
  scope: CacheScope | undefined,
  keepTransactions: boolean,
  { changes, onProgress, summary: fetchSummary }: LoadSources,
): Promise<{ data: FinanceData; savedAt?: string | undefined }> {
  const cacheScope = scope ?? anyOrganization;
  // A refusal elsewhere (another tab) after this point keeps this load's
  // summary from being saved.
  const { epoch, saved: hasCopy } = await store.position(cacheScope);
  // Other pages keep a saved copy current too, so what they change (such
  // as deleting a bank's data) reaches it.
  const pull = keepTransactions || hasCopy;
  const requests = [
    // Checked on arrival, so a stalled feed cannot delay the mismatch; and
    // bounded, so a stalled summary cannot keep the load from ending.
    withTimeout(fetchSummary()).then((data) => {
      if (
        scope &&
        (data.organizationId !== scope.organizationId ||
          data.userId !== scope.userId)
      )
        throw new OrganizationChanged();
      return data;
    }),
    pull
      ? pullTransactions(
          cacheScope,
          store,
          changes,
          onProgress,
          // Without a known organization there is nothing to check against.
          scope === undefined,
        )
      : Promise.resolve(),
  ] as const;
  const { failures, latest, summary } = await settle(
    store,
    cacheScope,
    requests,
  );
  const failure = failures[0];
  if (!keepTransactions) {
    // A saved copy that could not catch up is not this page's concern.
    if (summary.status === "rejected") throw summary.reason;
    if (!latest) throw failure;
    // A saved copy keeps the categories and accounts this page changed.
    if (pull) await store.saveSummary(cacheScope, latest, epoch);
    return { data: { ...latest, nextCursor: null, transactions: [] } };
  }
  if (latest) await store.saveSummary(cacheScope, latest, epoch);
  const saved = await store.read(cacheScope);
  const base = latest ?? saved.summary;
  // Offline, show the saved copy if a download ever finished.
  if (failure !== undefined && (!base || !saved.completedAt)) throw failure;
  if (!base) throw new Error("Could not load finances.");
  return {
    data: {
      ...base,
      nextCursor: null,
      transactions: saved.transactions.sort(newestFirst),
    },
    savedAt:
      failure === undefined ? undefined : (saved.completedAt ?? undefined),
  };
}

/**
 * Waits for both requests, raising what ends the load outright: a refusal
 * (at once, even while the other request still waits), a store falling back
 * to memory, or another organization's response.
 */
async function settle(
  store: TransactionStore,
  cacheScope: CacheScope,
  requests: readonly [Promise<FinanceData>, Promise<unknown>],
) {
  const [summary, pulled] = await Promise.race([
    Promise.allSettled(requests),
    firstEnding(requests),
  ]).catch(async (ending: unknown) => {
    // Another session's answer is not a refusal of this one's copy.
    throw refused(ending)
      ? await clearedFor(store, cacheScope, ending)
      : ending;
  });
  const failures = [summary, pulled].flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  const refusal = failures.find(refused);
  if (refusal !== undefined) throw await clearedFor(store, cacheScope, refusal);
  const fellBack = failures.find((cause) => cause instanceof StoreFellBack);
  if (fellBack) throw fellBack;
  const latest =
    summary.status === "fulfilled" ? summaryOf(summary.value) : undefined;
  // The session moved to another account or organization under this load:
  // nothing read may be saved or shown under this one.
  const changed = failures.find(
    (cause) => cause instanceof OrganizationChanged,
  );
  if (changed) throw changed;
  return { failures, latest, summary };
}

/**
 * Someone who lost access keeps nothing on the device, whichever Finance
 * page found out; pulls still running keep nothing either. Returns `refusal`
 * to report.
 */
async function clearedFor(
  store: TransactionStore,
  scope: CacheScope,
  refusal: unknown,
) {
  // Whoever ended this pull cleared the copy already; clearing again would
  // end a newer pull too.
  if (refusal instanceof SignedOut) return refusal;
  await store.clear(scope).catch(() => {
    // The refusal is what to report; storage errors matter less.
  });
  return refusal;
}

/**
 * Rejects with the first refusal or identity mismatch among `requests`:
 * either ends the load at once. Otherwise never settles.
 */
function firstEnding(requests: readonly Promise<unknown>[]) {
  return new Promise<never>((_resolve, reject) => {
    for (const request of requests)
      request.catch((cause: unknown) => {
        if (refused(cause) || cause instanceof OrganizationChanged)
          reject(cause);
      });
  });
}

/**
 * The saved copy, if a download into it ever finished: shown while a load
 * refreshes it, so a request that stalls cannot hide it.
 */
export async function savedFinance(
  store: TransactionStore,
  scope: CacheScope | undefined,
): Promise<FinanceData | undefined> {
  try {
    const saved = await store.read(scope ?? anyOrganization);
    if (!saved.completedAt || !saved.summary) return undefined;
    return {
      ...saved.summary,
      nextCursor: null,
      transactions: saved.transactions.sort(newestFirst),
    };
  } catch {
    // The load reports storage failures.
    return undefined;
  }
}

function summaryOf(data: FinanceData): FinanceSummary {
  const { nextCursor: _cursor, transactions: _transactions, ...summary } = data;
  return summary;
}
