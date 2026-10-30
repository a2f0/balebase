import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errors";

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A cursor-paginated list for `InfiniteScroll`. The first page reloads when
 * `fetchPage` changes identity (pass a `useCallback`) or `refreshKey`
 * changes; later pages append. A new `fetchPage` is a different list, so it
 * clears the old one; a refresh (`refreshKey` or `reload`) keeps the loaded
 * items on screen until the first page replaces them, so the page does not
 * collapse and lose its scroll position. A page requested before the newest
 * first page is dropped when it arrives, and no page loads during a refresh.
 * `generation` changes with each first page; key `InfiniteScroll` on it so a
 * refreshed list forgets which cursor it already loaded.
 */
export function useCursorPages<T>(
  fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
  fallback: string,
  refreshKey?: unknown,
) {
  const [items, setItems] = useState<T[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);
  const shown = useRef<typeof fetchPage>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and reloads restart the list without changing how a page is fetched.
  useEffect(() => {
    const request = ++latest.current;
    if (shown.current !== fetchPage) {
      shown.current = fetchPage;
      setItems(undefined);
      setNextCursor(null);
    }
    setError(undefined);
    setLoadingMore(false);
    setRefreshing(true);
    fetchPage().then(
      (page) => {
        if (request !== latest.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setGeneration(request);
        setRefreshing(false);
      },
      (cause: unknown) => {
        if (request !== latest.current) return;
        setError(errorMessage(cause, fallback));
        setRefreshing(false);
      },
    );
    return () => {
      latest.current += 1;
    };
  }, [fallback, fetchPage, refreshKey, reloads]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || refreshing) return false;
    const request = latest.current;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await fetchPage(nextCursor);
      if (request !== latest.current) return true;
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request === latest.current) setError(errorMessage(cause, fallback));
    } finally {
      if (request === latest.current) setLoadingMore(false);
    }
    return true;
  }, [fallback, fetchPage, nextCursor, refreshing]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  return {
    error,
    generation,
    items,
    loadMore,
    loadingMore,
    nextCursor,
    refreshing,
    reload,
  };
}
