import { useCallback, useMemo, useRef } from "react";
import { useLoad } from "../shared/useLoad";
import { type CacheScope, clearedOnRefusal, refused } from "./transactionCache";

/**
 * The scope by value: routes build a new scope object on every render, and
 * loads that depend on it must not repeat (and discard unsaved input) when
 * nothing changed.
 */
export function useCacheScope(
  scope: CacheScope | undefined,
): CacheScope | undefined {
  const organizationId = scope?.organizationId;
  const userId = scope?.userId;
  return useMemo(
    () => (organizationId && userId ? { organizationId, userId } : undefined),
    [organizationId, userId],
  );
}

/**
 * Wraps a record page's requests: a refusal (access ended) clears the saved
 * transactions and what the page shows at once, before it is reported, so
 * neither outlasts a reload that an outage could keep from finishing.
 */
export function useRefusalGuard(
  scope: CacheScope | undefined,
  setData: (data: undefined) => void,
) {
  return useCallback(
    <T>(work: Promise<T>) =>
      clearedOnRefusal(scope, work).catch((cause: unknown) => {
        if (refused(cause)) setData(undefined);
        throw cause;
      }),
    [scope, setData],
  );
}

/**
 * A record page's load, guarded: a refusal (even of a reload after an
 * action) clears the saved transactions and what the page shows. `load`
 * must keep its identity (a `useCallback`). Returns `guard` for the page's
 * other requests.
 */
export function useGuardedLoad<T>(
  givenScope: CacheScope | undefined,
  load: () => Promise<T>,
  fallback: string,
) {
  const scope = useCacheScope(givenScope);
  // `useLoad` keeps data on a failed reload; a refusal must not.
  const clearShown = useRef<(data: undefined) => void>(() => undefined);
  const loaded = useLoad(
    useCallback(
      () =>
        clearedOnRefusal(scope, load()).catch((cause: unknown) => {
          if (refused(cause)) clearShown.current(undefined);
          throw cause;
        }),
      [load, scope],
    ),
    fallback,
  );
  clearShown.current = loaded.setData;
  const guard = useRefusalGuard(scope, loaded.setData);
  return { ...loaded, guard, scope };
}
