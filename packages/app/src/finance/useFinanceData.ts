import { ApiError, type FinanceFilters } from "@balebase/api-client";
import type { FinanceData } from "@balebase/validators/finance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { syncPending, syncPollMs } from "./financeConnectionActions";
import { newestFirst } from "./financeTransactions";
import {
  type CacheScope,
  type FinanceSummary,
  indexedDbTransactionStore,
  memoryTransactionStore,
  pullTransactions,
  type TransactionStore,
} from "./transactionCache";

type CategoryRoute = Pick<FinanceFilters, "categorySlug" | "uncategorized">;

export const initialFilters: FinanceFilters = {
  accountIds: [],
  categorySlug: null,
  name: null,
  year: null,
  uncategorized: false,
};

/** Rows the overview shows at first, and adds each time it reaches the end. */
const transactionPageSize = 250;

/**
 * Finance's data. The overview (a non-null `route`, whose path selects the
 * category filters) keeps every transaction on this device and catches up
 * from the server's change feed on each load, so filters and paging are
 * local and the saved copy stays readable when the server cannot be reached.
 * Other pages read only connections, accounts, and categories.
 */
export function useFinanceData(
  route: CategoryRoute | null,
  scope: CacheScope | undefined,
) {
  const keepTransactions = route !== null;
  const store = useTransactionStore(scope);
  const [data, setData] = useState<FinanceData>();
  const [filters, setFilters] = useState({ ...initialFilters, ...route });
  const [visible, setVisible] = useState(transactionPageSize);
  const currentFilters = useRef(filters);
  const requestId = useRef(0);
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [savedCopy, setSavedCopy] = useState<string>();
  const [saving, setSaving] = useState<number>();
  const load = useCallback(async () => {
    const id = ++requestId.current;
    const current = () => id === requestId.current;
    setLoading(!loaded.current);
    setRefreshing(loaded.current);
    setLoadError(undefined);
    try {
      const next = await loadFinance(
        store.value,
        store.scope,
        keepTransactions,
        (saved) => {
          if (current()) setSaving(saved);
        },
      );
      if (!current()) return;
      loaded.current = true;
      setData(next.data);
      setSavedCopy(next.savedAt);
    } catch (cause) {
      if (current())
        setLoadError(errorMessage(cause, "Could not load finances."));
    } finally {
      if (current()) {
        setLoading(false);
        setRefreshing(false);
        setSaving(undefined);
      }
    }
  }, [keepTransactions, store]);
  useEffect(() => {
    void load();
    return () => {
      ++requestId.current;
    };
  }, [load]);
  useSyncPolling(data, load, loading || refreshing);
  const onFiltersChange = useCallback((next: FinanceFilters) => {
    currentFilters.current = next;
    setFilters(next);
    setVisible(transactionPageSize);
  }, []);
  useCategoryRoute(route, currentFilters, onFiltersChange);
  const onLoadMore = useCallback(async () => {
    setVisible((count) => count + transactionPageSize);
    return true;
  }, []);
  return {
    data,
    filters,
    loading,
    refreshing,
    loadError,
    /** When the saved copy shown was last current; set only while offline. */
    savedCopy,
    /** Transactions saved so far by a first download. */
    saving,
    visible,
    load,
    onFiltersChange,
    onLoadMore,
    setData,
  };
}

export type FinanceListingState = Omit<
  ReturnType<typeof useFinanceData>,
  "load" | "setData"
>;

/** Sign-in scopes keep IndexedDB; without one, or without IndexedDB, memory. */
function useTransactionStore(scope: CacheScope | undefined) {
  const userId = scope?.userId;
  const organizationId = scope?.organizationId;
  return useMemo(() => {
    const persistent =
      userId && organizationId && typeof indexedDB !== "undefined";
    return {
      scope: userId && organizationId ? { organizationId, userId } : undefined,
      value: persistent
        ? fallBack(indexedDbTransactionStore(), memoryTransactionStore())
        : memoryTransactionStore(),
    };
  }, [organizationId, userId]);
}

/**
 * IndexedDB can be missing in practice (private windows, full storage);
 * after its first failure the page keeps transactions in memory instead.
 */
function fallBack(
  primary: TransactionStore,
  secondary: TransactionStore,
): TransactionStore {
  let active = primary;
  async function attempt<T>(run: (store: TransactionStore) => Promise<T>) {
    if (active === secondary) return run(secondary);
    try {
      return await run(primary);
    } catch {
      active = secondary;
      return run(secondary);
    }
  }
  return {
    apply: (...args) => attempt((store) => store.apply(...args)),
    clear: (...args) => attempt((store) => store.clear(...args)),
    cursor: (...args) => attempt((store) => store.cursor(...args)),
    read: (...args) => attempt((store) => store.read(...args)),
    saveSummary: (...args) => attempt((store) => store.saveSummary(...args)),
  };
}

/** A refusal (signed out, no Finance access) rather than an unreachable server. */
function refused(cause: unknown) {
  return cause instanceof ApiError && cause.status < 500;
}

const anyOrganization: CacheScope = { organizationId: "", userId: "" };

async function loadFinance(
  store: TransactionStore,
  scope: CacheScope | undefined,
  keepTransactions: boolean,
  onProgress: (saved: number) => void,
) {
  const cacheScope = scope ?? anyOrganization;
  const [summary, pulled] = await Promise.allSettled([
    api.finance.summary(),
    keepTransactions
      ? pullTransactions(
          cacheScope,
          store,
          (cursor) => api.finance.transactionChanges(cursor),
          onProgress,
          // Without a known organization there is nothing to check against.
          scope === undefined,
        )
      : Promise.resolve(),
  ]);
  const failure = [summary, pulled].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )?.reason;
  if (failure !== undefined && refused(failure)) {
    // Someone who lost access keeps nothing on the device.
    if (keepTransactions) await store.clear(cacheScope);
    throw failure;
  }
  const latest =
    summary.status === "fulfilled" ? summaryOf(summary.value) : undefined;
  if (!keepTransactions) {
    if (!latest) throw failure;
    return { data: { ...latest, nextCursor: null, transactions: [] } };
  }
  if (latest) await store.saveSummary(cacheScope, latest);
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

/** Back, Forward, and links to a category path keep the other filters. */
function useCategoryRoute(
  route: CategoryRoute | null,
  currentFilters: { current: FinanceFilters },
  onFiltersChange: (next: FinanceFilters) => void,
) {
  const slug = route?.categorySlug;
  const uncategorized = route?.uncategorized;
  useEffect(() => {
    const current = currentFilters.current;
    if (
      slug === undefined ||
      uncategorized === undefined ||
      (current.categorySlug === slug && current.uncategorized === uncategorized)
    ) {
      return;
    }
    onFiltersChange({ ...current, categorySlug: slug, uncategorized });
  }, [currentFilters, onFiltersChange, slug, uncategorized]);
}

function useSyncPolling(
  data: FinanceData | undefined,
  load: () => Promise<void>,
  busy: boolean,
) {
  const connections = data?.connections;
  // Connections keep their identity until the next load, so polling restarts
  // only when fresh data arrives.
  const ids = useMemo(
    () =>
      connections
        ?.filter((connection) => syncPending(connection.syncStatus))
        .map((connection) => connection.id) ?? [],
    [connections],
  );
  useEffect(() => {
    if (!ids.length || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const statuses = await Promise.all(
          ids.map((id) => api.finance.syncStatus(id)),
        );
        // Reload history once a job finishes; retries only read small metadata.
        if (
          active &&
          statuses.some(
            ({ connection }) => !syncPending(connection.syncJob?.status),
          )
        )
          await load();
      } catch {
        // Keep the saved pending state and retry after temporary request failures.
      }
      if (active) timer = setTimeout(() => void poll(), syncPollMs);
    }
    timer = setTimeout(() => void poll(), syncPollMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ids, load, busy]);
}
