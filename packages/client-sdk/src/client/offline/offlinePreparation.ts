import type { OfflineIdentity } from "../../data/offline/offlineWorkspace";
import type { OfflineRuntime } from "./offlineRuntime";

/**
 * Makes `identity`'s workspace on this device, if it has none, and makes it
 * the active one, once the host can reopen offline.
 */
export async function prepareOfflineDevice(
  { store, waitForOfflineShell }: OfflineRuntime,
  identity: OfflineIdentity,
  epoch: string,
) {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely sync offline work. Update your browser and try again.",
    );
  await waitForOfflineShell?.();
  const key = store.scopeKey(identity.scope);
  await store.change(
    key,
    (current) => current ?? store.emptyWorkspace(identity),
  );
  store.activate(key, epoch);
  // Unsynced forms and photos live here; ask the browser not to evict them.
  await navigator.storage?.persist?.().catch(() => false);
}
