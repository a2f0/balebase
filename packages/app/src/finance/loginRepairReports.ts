import { ApiError } from "@balebase/api-client";
import { api } from "../shared/apiClient";

/**
 * Login repairs Plaid confirmed in this browser that the API has not yet
 * recorded. Plaid tells only the browser, so a report lost to a network
 * failure or a closed tab would leave the repair with no history; each one
 * stays here until the API records it, or for as long as its Link session
 * lasts. A refusal does not drop it: the report may belong to another
 * account or organization than the one signed in now, and is retried after
 * a switch back. A malformed one is dropped.
 */
const pendingRepairsKey = "balebase.plaid.pendingRepairs";

/** As long as the API keeps an update-mode Link session. */
const pendingMilliseconds = 4 * 60 * 60 * 1_000;

interface PendingRepair {
  connectionId: string;
  createdAt: number;
  linkToken: string;
}

function pendingRepairs(): PendingRepair[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(pendingRepairsKey) ?? "[]",
    );
    const now = Date.now();
    return Array.isArray(stored)
      ? stored
          .filter(isPendingRepair)
          .filter(({ createdAt }) => now - createdAt < pendingMilliseconds)
      : [];
  } catch {
    return [];
  }
}

function isPendingRepair(value: unknown): value is PendingRepair {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "connectionId") === "string" &&
    typeof Reflect.get(value, "createdAt") === "number" &&
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
    if (cause instanceof ApiError && cause.status === 400) forget(repair);
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
  const repair = { connectionId, createdAt: Date.now(), linkToken };
  storePending([...pendingRepairs(), repair]);
  return send(repair);
}

/** Retries reports an earlier page load could not deliver. */
export async function retryPendingLoginRepairs() {
  for (const repair of pendingRepairs()) await send(repair);
}
