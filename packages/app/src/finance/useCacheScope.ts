import { useMemo } from "react";
import type { CacheScope } from "./transactionCache";

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
