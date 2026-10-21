import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FinanceData,
  type FinanceFilters,
  getFinanceData,
} from "./financeApi";

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
        setRequestError(financeLoadMessage(cause));
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
  const onFiltersChange = useCallback(
    (next: FinanceFilters) => {
      currentFilters.current = next;
      setFilters(next);
      void load(undefined, true);
    },
    [load],
  );
  useCategoryRoute(route, currentFilters, onFiltersChange);
  async function onLoadMore() {
    if (
      data?.nextCursor &&
      !loading &&
      !loadingMore &&
      !refreshing &&
      filters === loadedFilters.current
    )
      await load(data.nextCursor);
  }
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
  const result = await getFinanceData(filters, cursor);
  if (cursor) return result;
  while (
    current() &&
    result.nextCursor &&
    result.transactions.length < minimum
  ) {
    const next = await getFinanceData(filters, result.nextCursor);
    result.transactions.push(...next.transactions);
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
    transactions: [...current.transactions, ...next.transactions],
  };
}

function financeLoadMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load finances.";
}
