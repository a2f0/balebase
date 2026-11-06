import { useEffect, useReducer } from "react";
import { errorMessage } from "../shared/errors";
import { isOnline, onNetworkChange, useOnline } from "../shared/network";
import {
  activeOfflineKey,
  type OfflineWorkspace,
  offlineChanged,
  readOfflineWorkspace,
} from "./offlineStore";
import { syncOfflineWorkspace } from "./offlineSync";
import {
  initialOfflineWorkspace,
  offlineWorkspaceError,
  offlineWorkspaceTransition,
} from "./offlineWorkspaceState";

/** Storage the hook reads and syncs; tests pass their own. */
export interface OfflineWorkspaceStorage {
  read: (key: string) => Promise<OfflineWorkspace | undefined>;
  /** Resolves whether the drain ran; a skipped one reports nothing. */
  sync: (key: string) => Promise<boolean>;
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
 * Reads and syncs overlap, so their results go through one machine
 * (`offlineWorkspaceState.ts`) keyed by the active workspace: only the
 * newest read lands, each kind keeps its own error, and changing workspace
 * drops the last one's errors.
 */
export function useOfflineWorkspace(storage = deviceStorage) {
  const [state, dispatch] = useReducer(
    offlineWorkspaceTransition,
    initialOfflineWorkspace,
  );
  const online = useOnline();
  useEffect(() => {
    let current = true;
    let loads = 0;
    const send: typeof dispatch = (event) => {
      if (current) dispatch(event);
    };
    const load = async (key: string | null) => {
      const request = ++loads;
      send({ key, request, type: "loadStarted" });
      try {
        const workspace = key ? await storage.read(key) : undefined;
        send({ request, type: "loadLanded", workspace });
      } catch (cause) {
        send({
          message: errorMessage(cause, "Offline storage is unavailable."),
          request,
          type: "loadFailed",
        });
      }
    };
    const sync = async (key: string | null) => {
      if (!key || !isOnline()) return;
      try {
        if (await storage.sync(key)) send({ key, type: "syncSucceeded" });
      } catch (cause) {
        send({
          key,
          message: errorMessage(cause, "Could not sync offline work."),
          type: "syncFailed",
        });
      }
    };
    const refresh = () => {
      const key = activeOfflineKey();
      void load(key);
      void sync(key);
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
  return {
    workspace: state.workspace,
    online,
    error: offlineWorkspaceError(state),
  };
}
