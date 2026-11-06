import { useEffect, useState } from "react";
import { errorMessage } from "../shared/errors";
import { isOnline, onNetworkChange, useOnline } from "../shared/network";
import {
  activeOfflineKey,
  type OfflineWorkspace,
  offlineChanged,
  readOfflineWorkspace,
} from "./offlineStore";
import { syncOfflineWorkspace } from "./offlineSync";

/** Storage the hook reads and syncs; tests pass their own. */
export interface OfflineWorkspaceStorage {
  read: (key: string) => Promise<OfflineWorkspace | undefined>;
  sync: (key: string) => Promise<unknown>;
}

const deviceStorage: OfflineWorkspaceStorage = {
  read: readOfflineWorkspace,
  sync: syncOfflineWorkspace,
};

/**
 * The active workspace on this device, reloaded whenever it changes here or
 * in another tab, and its queued work sent whenever the device is online:
 * now, on reconnecting, on focus, and every 30 seconds.
 *
 * Reads and syncs overlap, so only the newest of each kind reports, and each
 * kind keeps its own error: a read landing does not hide a sync that still
 * fails, and an older read's failure never covers newer data.
 */
export function useOfflineWorkspace(storage = deviceStorage) {
  const [workspace, setWorkspace] = useState<OfflineWorkspace>();
  const online = useOnline();
  const [loadError, setLoadError] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  useEffect(() => {
    let current = true;
    let loads = 0;
    let syncs = 0;
    const load = async () => {
      const request = ++loads;
      const key = activeOfflineKey();
      try {
        const saved = key ? await storage.read(key) : undefined;
        if (current && request === loads) {
          setWorkspace(saved);
          setLoadError(undefined);
        }
      } catch (cause) {
        if (current && request === loads)
          setLoadError(errorMessage(cause, "Offline storage is unavailable."));
      }
    };
    const sync = async () => {
      const key = activeOfflineKey();
      if (!key || !isOnline()) return;
      const request = ++syncs;
      try {
        await storage.sync(key);
        if (current && request === syncs) setSyncError(undefined);
      } catch (cause) {
        if (current && request === syncs)
          setSyncError(errorMessage(cause, "Could not sync offline work."));
      }
    };
    const refresh = () => {
      void load();
      void sync();
    };
    refresh();
    window.addEventListener(offlineChanged, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    const stopWatching = onNetworkChange(refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      current = false;
      window.clearInterval(timer);
      stopWatching();
      for (const event of [offlineChanged, "storage", "focus"])
        window.removeEventListener(event, refresh);
    };
  }, [storage]);
  return { workspace, online, error: loadError ?? syncError };
}
