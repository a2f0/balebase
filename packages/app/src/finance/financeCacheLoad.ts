import { ApiError } from "@balebase/api-client";
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
  SignedOut,
  type TransactionStore,
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
    clear: (...args) => attempt((store) => store.clear(...args)),
    position: (...args) => attempt((store) => store.position(...args)),
    read: (...args) => attempt((store) => store.read(...args)),
    restart: (...args) => attempt((store) => store.restart(...args)),
    saveSummary: (...args) => attempt((store) => store.saveSummary(...args)),
  };
}

/**
 * A refusal (signed out, no Finance access) rather than an unreachable
 * server: nothing saved or shown may outlast it.
 */
export function refused(cause: unknown) {
  return (
    cause instanceof SignedOut ||
    (cause instanceof ApiError &&
      (cause.status === 401 || cause.status === 403))
  );
}

const anyOrganization: CacheScope = { organizationId: "", userId: "" };

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
  const { epoch } = keepTransactions
    ? await store.position(cacheScope)
    : { epoch: "" };
  const [summary, pulled] = await Promise.allSettled([
    fetchSummary(),
    keepTransactions
      ? pullTransactions(
          cacheScope,
          store,
          changes,
          onProgress,
          // Without a known organization there is nothing to check against.
          scope === undefined,
        )
      : Promise.resolve(),
  ]);
  const failures = [summary, pulled].flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  // Either request may be the one refused; an outage of the other must not
  // hide it.
  const refusal = failures.find(refused);
  if (refusal !== undefined) {
    // Someone who lost access keeps nothing on the device, whichever Finance
    // page found out.
    await store.clear(cacheScope).catch(() => {
      // The refusal is what to report; storage errors matter less.
    });
    throw refusal;
  }
  const fellBack = failures.find((cause) => cause instanceof StoreFellBack);
  if (fellBack) throw fellBack;
  const latest =
    summary.status === "fulfilled" ? summaryOf(summary.value) : undefined;
  // The session moved to another organization under this load: nothing
  // read may be saved or shown under this one.
  if (latest && scope && latest.organizationId !== scope.organizationId)
    throw new OrganizationChanged();
  const changed = failures.find(
    (cause) => cause instanceof OrganizationChanged,
  );
  if (changed) throw changed;
  const failure = failures[0];
  if (!keepTransactions) {
    if (!latest) throw failure;
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

function summaryOf(data: FinanceData): FinanceSummary {
  const { nextCursor: _cursor, transactions: _transactions, ...summary } = data;
  return summary;
}
