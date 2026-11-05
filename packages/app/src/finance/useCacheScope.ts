import { useCallback, useMemo, useRef } from "react";
import { useLoad } from "../shared/useLoad";
import {
  type CacheScope,
  clearedOnRefusal,
  refused,
  SignedOut,
} from "./transactionCache";

/**
 * The scope by value: routes build a new scope object on every render, and
 * loads that depend on it must not repeat (and discard unsaved input) when
 * nothing changed.
 */
function useCacheScope(scope: CacheScope | undefined): CacheScope | undefined {
  const organizationId = scope?.organizationId;
  const userId = scope?.userId;
  return useMemo(
    () => (organizationId && userId ? { organizationId, userId } : undefined),
    [organizationId, userId],
  );
}

/**
 * A record page's load, guarded: a refusal (of the load, a reload after an
 * action, or any request passed through the returned `guard`) clears the
 * saved transactions and what the page shows at once, and drops loads still
 * running, so nothing outlasts a reload an outage could keep from
 * finishing. `load` must keep its identity (a `useCallback`).
 */
export function useGuardedLoad<T>(
  givenScope: CacheScope | undefined,
  load: () => Promise<T>,
  fallback: string,
) {
  const scope = useCacheScope(givenScope);
  // Advanced by each refusal; a load started before one shows nothing.
  const refusals = useRef(0);
  // `useLoad` keeps data on a failed reload; a refusal must not.
  const clearShown = useRef<(data: undefined) => void>(() => undefined);
  const onRefusal = useCallback((cause: unknown) => {
    if (!refused(cause)) return;
    refusals.current += 1;
    clearShown.current(undefined);
  }, []);
  const loaded = useLoad(
    useCallback(async () => {
      const started = refusals.current;
      const value = await clearedOnRefusal(scope, load()).catch(
        (cause: unknown) => {
          onRefusal(cause);
          throw cause;
        },
      );
      if (refusals.current !== started) throw new SignedOut();
      return value;
    }, [load, onRefusal, scope]),
    fallback,
  );
  clearShown.current = loaded.setData;
  const guard = useCallback(
    <R>(work: Promise<R>) =>
      clearedOnRefusal(scope, work).catch((cause: unknown) => {
        onRefusal(cause);
        throw cause;
      }),
    [onRefusal, scope],
  );
  return { ...loaded, guard, scope };
}
