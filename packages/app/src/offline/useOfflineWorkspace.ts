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

/**
 * The active workspace on this device, reloaded whenever it changes here or
 * in another tab, and its queued work sent whenever the device is online:
 * now, on reconnecting, on focus, and every 30 seconds.
 */
export function useOfflineWorkspace() {
  const [workspace, setWorkspace] = useState<OfflineWorkspace>();
  const online = useOnline();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      const key = activeOfflineKey();
      try {
        const saved = key ? await readOfflineWorkspace(key) : undefined;
        if (current && request === generation) {
          setWorkspace(saved);
          setError(undefined);
        }
      } catch (cause) {
        if (current)
          setError(errorMessage(cause, "Offline storage is unavailable."));
      }
    };
    const sync = () => {
      const key = activeOfflineKey();
      if (key && isOnline())
        void syncOfflineWorkspace(key).catch((cause: unknown) => {
          if (current)
            setError(errorMessage(cause, "Could not sync offline work."));
        });
    };
    const refresh = () => {
      void load();
      sync();
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
  }, []);
  return { workspace, online, error };
}
