import { ApiError } from "@balebase/api-client";
import { api } from "../shared/apiClient";

/**
 * Login repairs Plaid confirmed in this browser that the API has not yet
 * recorded. Plaid tells only the browser, so a report lost to a network
 * failure or a closed tab would leave the repair with no history; each one
 * stays here until the API records it or refuses it for good.
 */
const pendingRepairsKey = "balebase.plaid.pendingRepairs";

const refusals = new Set([400, 403, 404, 409, 410, 422]);

interface PendingRepair {
  connectionId: string;
  linkToken: string;
}

function pendingRepairs(): PendingRepair[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(pendingRepairsKey) ?? "[]",
    );
    return Array.isArray(stored) ? stored.filter(isPendingRepair) : [];
  } catch {
    return [];
  }
}

function isPendingRepair(value: unknown): value is PendingRepair {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "connectionId") === "string" &&
    typeof Reflect.get(value, "linkToken") === "string"
  );
}

function storePending(repairs: PendingRepair[]) {
  if (repairs.length)
    localStorage.setItem(pendingRepairsKey, JSON.stringify(repairs));
  else localStorage.removeItem(pendingRepairsKey);
}

function forget(repair: PendingRepair) {
  storePending(
    pendingRepairs().filter(
      (pending) =>
        pending.connectionId !== repair.connectionId ||
        pending.linkToken !== repair.linkToken,
    ),
  );
}

/** Sends one report; false when it should be tried again later. */
async function send(repair: PendingRepair) {
  try {
    await api.finance.reportPlaidLoginRepair(
      repair.connectionId,
      repair.linkToken,
    );
  } catch (cause) {
    // A refused report (no such session, already recorded, or expired)
    // never succeeds on retry; a signed-out or rate-limited one may.
    if (cause instanceof ApiError && refusals.has(cause.status)) forget(repair);
    return false;
  }
  forget(repair);
  return true;
}

/**
 * Reports a repair Plaid Link confirmed, keeping it to retry when the API
 * cannot be reached. Returns whether it was recorded now.
 */
export function reportLoginRepair(connectionId: string, linkToken: string) {
  const repair = { connectionId, linkToken };
  storePending([...pendingRepairs(), repair]);
  return send(repair);
}

/** Retries reports an earlier page load could not deliver. */
export async function retryPendingLoginRepairs() {
  for (const repair of pendingRepairs()) await send(repair);
}
