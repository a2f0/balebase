import { useCallback, useMemo } from "react";
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
