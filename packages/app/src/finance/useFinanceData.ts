import type { FinanceFilters } from "@balebase/api-client";
import type { FinanceData } from "@balebase/validators/finance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import {
  fallBack,
  forgetFinance,
  loadFinance,
  savedFinance,
} from "./financeCacheLoad";
import { syncPending, syncPollMs } from "./financeConnectionActions";
import {
  type CacheScope,
  clears,
  indexedDbTransactionStore,
  memoryTransactionStore,
  OrganizationChanged,
  onClearedElsewhere,
  refused,
  SignedOut,
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
 * Other pages show only connections, accounts, and categories, and bring a
 * saved copy up to date so what they change reaches it.
 */
export function useFinanceData(
  route: CategoryRoute | null,
  scope: CacheScope | undefined,
) {
  const keepTransactions = route !== null;
  const store = useTransactionStore(scope);
  const loaded = useCachedLoad(keepTransactions, store);
  // Another tab found access gone (or signed out): this one's view and copy
  // (IndexedDB, or memory after a fallback) go too.
  useClearedElsewhere(store.scope, () => {
    void loaded.onRefused(new SignedOut(), false);
  });
  const [filters, setFilters] = useState({ ...initialFilters, ...route });
  const [visible, setVisible] = useState(transactionPageSize);
  const currentFilters = useRef(filters);
  useSyncPolling(
    loaded.data,
    loaded.load,
    loaded.onRefused,
    loaded.loading || loaded.refreshing,
  );
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
    ...loaded,
    filters,
    visible,
    onFiltersChange,
    onLoadMore,
  };
}

/** Loads Finance's data from `store` and the server, and forgets it on refusal. */
function useCachedLoad(
  keepTransactions: boolean,
  store: ReturnType<typeof useTransactionStore>,
) {
  const [data, setData] = useState<FinanceData>();
  const requestId = useRef(0);
  const loaded = useRef(false);
  // Whether transactions were ever shown: Categories and Connections load
  // without them, so the overview's first visit after them still loads.
  const loadedTransactions = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [savedCopy, setSavedCopy] = useState<string>();
  const [saving, setSaving] = useState<number>();
  const settle = useCallback((error?: string) => {
    setLoading(false);
    setRefreshing(false);
    setSaving(undefined);
    if (error !== undefined) setLoadError(error);
  }, []);
  const forget = useCallback(() => {
    loaded.current = false;
    loadedTransactions.current = false;
    setData(undefined);
    setSavedCopy(undefined);
  }, []);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    const current = () => id === requestId.current;
    const first =
      !loaded.current || (keepTransactions && !loadedTransactions.current);
    setLoading(first);
    setRefreshing(!first);
    setLoadError(undefined);
    if (first && keepTransactions) {
      // Shown at once and refreshed, so a stalled request cannot hide it.
      const saved = await savedFinance(store.value, store.scope);
      if (saved && current()) {
        setData(saved);
        setLoading(false);
        setRefreshing(true);
      }
    }
    try {
      const next = await loadFinance(
        store.value,
        store.scope,
        keepTransactions,
        {
          changes: (cursor) => api.finance.transactionChanges(cursor),
          onProgress: (saved) => {
            if (current()) setSaving(saved);
          },
          summary: () => api.finance.summary(),
        },
      );
      if (!current()) return;
      loaded.current = true;
      // A load for another page leaves no transactions to show.
      loadedTransactions.current = keepTransactions;
      setData(next.data);
      setSavedCopy(next.savedAt);
      settle();
    } catch (cause) {
      if (!current()) return;
      // Nothing read before stays on screen after access ends, or once the
      // session belongs to another account or organization.
      if (refused(cause) || cause instanceof OrganizationChanged) forget();
      settle(errorMessage(cause, "Could not load finances."));
    }
  }, [forget, keepTransactions, settle, store]);
  const onRefused = useRefusal(store, requestId, forget, settle);
  useEffect(() => {
    void load();
    return () => {
      ++requestId.current;
    };
  }, [load]);
  return {
    data,
    loading,
    refreshing,
    loadError,
    /** When the saved copy shown was last current; set only while offline. */
    savedCopy,
    /** Transactions saved so far by a first download. */
    saving,
    load,
    onRefused,
    setData,
  };
}

/**
 * Calls `onCleared` when another tab clears the saved transactions `scope`
 * shows (access ended there, or a sign-out), so this one drops them too.
 */
function useClearedElsewhere(
  scope: CacheScope | undefined,
  onCleared: () => void,
) {
  const latest = useRef(onCleared);
  latest.current = onCleared;
  useEffect(() => {
    if (!scope) return;
    return onClearedElsewhere((cleared) => {
      if (clears(cleared, scope)) latest.current();
    });
  }, [scope]);
}

export type FinanceListingState = Omit<
  ReturnType<typeof useFinanceData>,
  "load" | "onRefused" | "setData"
>;

/**
 * A save was refused (or another tab, which `announce: false` does not tell
 * again, found access gone): nothing shown or saved stays, without waiting on
 * a reload an outage could stall. A refusal for an earlier organization's
 * store (the session moved on) forgets only that one's saved copy.
 */
function useRefusal(
  store: ReturnType<typeof useTransactionStore>,
  requestId: { current: number },
  forget: () => void,
  settle: (error?: string) => void,
) {
  const isShown = useIsLatest(store);
  return useCallback(
    async (cause: unknown, announce = true) => {
      if (isShown(store)) {
        // Loads still running would show what they read.
        ++requestId.current;
        forget();
        settle(errorMessage(cause, "Could not load finances."));
      }
      await forgetFinance(store.value, store.scope, announce);
    },
    [forget, isShown, requestId, settle, store],
  );
}

/** Whether a value is the latest one rendered. */
function useIsLatest<Value>(value: Value) {
  const latest = useRef(value);
  latest.current = value;
  return useCallback((candidate: Value) => candidate === latest.current, []);
}

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
  onRefused: (cause: unknown) => Promise<void>,
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
      } catch (cause) {
        // Access ended: stop, keeping nothing shown or saved.
        if (refused(cause)) {
          if (active) await onRefused(cause);
          return;
        }
        // Keep the saved pending state and retry after temporary request failures.
      }
      if (active) timer = setTimeout(() => void poll(), syncPollMs);
    }
    timer = setTimeout(() => void poll(), syncPollMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ids, load, onRefused, busy]);
}
