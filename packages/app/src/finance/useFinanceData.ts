import type { FinanceFilters } from "@balebase/api-client";
import type { FinanceData } from "@balebase/validators/finance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { syncPending, syncPollMs } from "./financeConnectionActions";

type CategoryRoute = Pick<FinanceFilters, "categorySlug" | "uncategorized">;

export const initialFilters: FinanceFilters = {
  accountIds: [],
  categorySlug: null,
  year: null,
  uncategorized: false,
};

/**
 * Keep account cards visible while loading, but never show a stale result set.
 * The overview's path selects the category filters; other pages pass null.
 */
export function useFinanceData(route: CategoryRoute | null) {
  const [data, setData] = useState<FinanceData>();
  const [filters, setFilters] = useState({ ...initialFilters, ...route });
  const currentFilters = useRef(filters);
  const loadedFilters = useRef(filters);
  const loadedData = useRef(data);
  useEffect(() => {
    loadedData.current = data;
  }, [data]);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const load = useCallback(async (cursor?: string, reset = false) => {
    const id = ++requestId.current;
    const filters = currentFilters.current;
    const refresh = !reset && loadedFilters.current === filters;
    setLoading(!cursor && !refresh);
    setLoadingMore(Boolean(cursor));
    setRefreshing(!cursor && refresh);
    setLoadError(undefined);
    setLoadMoreError(undefined);
    const setRequestError = cursor ? setLoadMoreError : setLoadError;
    const minimum = refresh
      ? (loadedData.current?.transactions.length ?? 0)
      : 0;
    try {
      const next = await loadFinancePages(
        filters,
        cursor,
        minimum,
        () => id === requestId.current,
      );
      if (id !== requestId.current) return;
      loadedFilters.current = filters;
      setData((current) => mergeFinancePage(current, next, cursor));
    } catch (cause) {
      if (id === requestId.current) {
        setRequestError(errorMessage(cause, "Could not load finances."));
      }
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      ++requestId.current;
    };
  }, [load]);
  useSyncPolling(data, load, loading || loadingMore || refreshing);
  const onFiltersChange = useCallback(
    (next: FinanceFilters) => {
      currentFilters.current = next;
      setFilters(next);
      void load(undefined, true);
    },
    [load],
  );
  useCategoryRoute(route, currentFilters, onFiltersChange);
  const cursor = data?.nextCursor;
  const canLoadMore =
    !(loading || loadingMore || refreshing) &&
    filters === loadedFilters.current;
  const onLoadMore = useCallback(async () => {
    if (!cursor || !canLoadMore) return false;
    await load(cursor);
    return true;
  }, [canLoadMore, cursor, load]);
  return {
    data,
    filters,
    loading: loading || filters !== loadedFilters.current,
    loadingMore,
    refreshing,
    loadError,
    loadMoreError,
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

/** Refresh every loaded page so saving a note does not lose the user's place. */
async function loadFinancePages(
  filters: FinanceFilters,
  cursor: string | undefined,
  minimum: number,
  current: () => boolean,
) {
  const result = await api.finance.data(filters, cursor);
  if (cursor) return result;
  while (
    current() &&
    result.nextCursor &&
    result.transactions.length < minimum
  ) {
    const next = await api.finance.data(filters, result.nextCursor);
    result.transactions = mergeTransactions(
      result.transactions,
      next.transactions,
    );
    result.nextCursor = next.nextCursor;
  }
  return result;
}

function mergeFinancePage(
  current: FinanceData | undefined,
  next: FinanceData,
  cursor: string | undefined,
) {
  if (!cursor || !current) return next;
  return {
    ...next,
    transactions: mergeTransactions(current.transactions, next.transactions),
  };
}

function mergeTransactions(
  current: FinanceData["transactions"],
  next: FinanceData["transactions"],
) {
  return [
    ...new Map(
      [...current, ...next].map((transaction) => [transaction.id, transaction]),
    ).values(),
  ];
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
