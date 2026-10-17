import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FinanceData,
  type FinanceFilters,
  getFinanceData,
} from "./financeApi";

const initialFilters: FinanceFilters = {
  accountIds: [],
  year: null,
  uncategorized: false,
};

/** Keep account cards visible while loading, but never show a stale result set. */
export function useFinanceData() {
  const [data, setData] = useState<FinanceData>();
  const [filters, setFilters] = useState(initialFilters);
  const currentFilters = useRef(filters);
  const loadedFilters = useRef(filters);
  const loadedData = useRef(data);
  useEffect(() => {
    loadedData.current = data;
  }, [data]);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const load = useCallback(async (cursor?: string, reset = false) => {
    const id = ++requestId.current;
    const filters = currentFilters.current;
    const refresh = !reset && loadedFilters.current === filters;
    setLoading(!cursor && !refresh);
    setLoadingMore(Boolean(cursor));
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
      }
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      ++requestId.current;
    };
  }, [load]);
  function onFiltersChange(next: FinanceFilters) {
    currentFilters.current = next;
    setFilters(next);
    void load(undefined, true);
  }
  async function onLoadMore() {
    if (
      data?.nextCursor &&
      !loading &&
      !loadingMore &&
      filters === loadedFilters.current
    )
      await load(data.nextCursor);
  }
  return {
    data,
    filters,
    loading: loading || filters !== loadedFilters.current,
    loadingMore,
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
