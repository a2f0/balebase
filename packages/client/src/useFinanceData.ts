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
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const load = useCallback(async (cursor?: string) => {
    const id = ++requestId.current;
    setLoading(!cursor);
    setLoadingMore(Boolean(cursor));
    setLoadError(undefined);
    try {
      const next = await getFinanceData(currentFilters.current, cursor);
      if (id !== requestId.current) return;
      setData((current) => ({
        ...next,
        transactions: cursor
          ? [...(current?.transactions ?? []), ...next.transactions]
          : next.transactions,
      }));
    } catch (cause) {
      if (id === requestId.current) {
        setLoadError(
          cause instanceof Error ? cause.message : "Could not load finances.",
        );
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
    void load();
  }
  async function onLoadMore() {
    if (data?.nextCursor && !loading && !loadingMore)
      await load(data.nextCursor);
  }
  return {
    data,
    filters,
    loading,
    loadingMore,
    loadError,
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
