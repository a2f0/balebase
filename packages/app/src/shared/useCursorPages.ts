import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type CursorPage,
  type CursorPagesEvent,
  type CursorPagesState,
  cursorPagesTransition,
  initialCursorPages,
} from "./cursorPagesState";
import { errorMessage } from "./errors";

/**
 * A cursor-paginated list for `InfiniteScroll`. The first page reloads when
 * `fetchPage` changes identity (pass a `useCallback`) or `refreshKey`
 * changes; later pages append. A new `fetchPage` is a different list, so it
 * clears the old one; a refresh (`refreshKey` or `reload`) keeps the loaded
 * items on screen until the first page replaces them, so the page does not
 * collapse and lose its scroll position. A page requested before the newest
 * first page is dropped when it arrives, and no page loads during a refresh.
 * `generation` changes with each first page; key `InfiniteScroll` on it so a
 * refreshed list forgets which cursor it already loaded. The states and
 * their transitions are in `cursorPagesState.ts`.
 */
export function useCursorPages<T>(
  fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
  fallback: string,
  refreshKey?: unknown,
) {
  const [state, dispatch] = useReducer<
    CursorPagesState<T>,
    [CursorPagesEvent<T>]
  >(cursorPagesTransition, initialCursorPages);
  const [reloads, setReloads] = useState(0);
  // Tags every request: only the one in flight can finish the list, so a
  // response for a replaced list or an unmounted page changes nothing.
  const requests = useRef(0);
  const shown = useRef<typeof fetchPage>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and reloads restart the list without changing how a page is fetched.
  useEffect(() => {
    const request = ++requests.current;
    const clear = shown.current !== fetchPage;
    shown.current = fetchPage;
    dispatch({ type: "refresh", request, clear });
    // A cleaned-up effect (unmount, Strict Mode's remount) reports nothing.
    let active = true;
    fetchPage().then(
      (page) => {
        if (active) dispatch({ type: "firstPage", request, page });
      },
      (cause: unknown) => {
        if (!active) return;
        dispatch({
          type: "failed",
          request,
          error: errorMessage(cause, fallback),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [fallback, fetchPage, refreshKey, reloads]);

  const loadMore = useCallback(async () => {
    const cursor = state.status === "idle" ? state.list?.nextCursor : null;
    if (!cursor) return false;
    const request = ++requests.current;
    dispatch({ type: "loadMore", request });
    try {
      const page = await fetchPage(cursor);
      dispatch({ type: "nextPage", request, page });
    } catch (cause) {
      dispatch({
        type: "failed",
        request,
        error: errorMessage(cause, fallback),
      });
    }
    return true;
  }, [fallback, fetchPage, state]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  return {
    error: state.status === "idle" ? state.error : undefined,
    generation: state.list?.generation ?? 0,
    items: state.list?.items,
    loadMore,
    loadingMore: state.status === "loadingMore",
    nextCursor: state.list?.nextCursor ?? null,
    refreshing: state.status === "refreshing",
    reload,
  };
}
