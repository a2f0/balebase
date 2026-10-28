import { useEffect, useState } from "react";
import { errorMessage } from "./errors";
import {
  activeOfflineKey,
  type OfflineWorkspace,
  offlineChanged,
  readOfflineWorkspace,
} from "./offlineStore";
import { syncOfflineWorkspace } from "./offlineSync";

export function useOfflineWorkspace() {
  const [workspace, setWorkspace] = useState<OfflineWorkspace>();
  const [online, setOnline] = useState(navigator.onLine);
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
      setOnline(navigator.onLine);
      const key = activeOfflineKey();
      if (key)
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
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      current = false;
      window.clearInterval(timer);
      for (const event of [
        offlineChanged,
        "storage",
        "online",
        "offline",
        "focus",
      ])
        window.removeEventListener(event, refresh);
    };
  }, []);
  return { workspace, online, error };
}
