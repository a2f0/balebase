import { useSyncExternalStore } from "react";
import { type NetworkStatusSource, networkSource } from "../host";

/**
 * The browser's own connectivity: `navigator.onLine` and the window's
 * `online` and `offline` events. Accurate in browsers; the Capacitor shell
 * supplies the OS's instead (`AppHost.network`), because an Android WebView
 * can report offline while the device is connected.
 */
const browserNetwork: NetworkStatusSource = {
  getOnline: () => navigator.onLine,
  subscribe(listener) {
    const online = () => listener(true);
    const offline = () => listener(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  },
};

/**
 * Whether the device has a network. A request that fails while this is true
 * means the API is unreachable, not that the device went offline, so work
 * keeps retrying rather than waiting for a change that may never come.
 */
export function isOnline() {
  return (networkSource() ?? browserNetwork).getOnline();
}

/** Calls `listener` with each change in connectivity; returns an unsubscribe. */
export function onNetworkChange(listener: (online: boolean) => void) {
  return (networkSource() ?? browserNetwork).subscribe(listener);
}

/** `isOnline()`, re-rendering when it changes. */
export function useOnline() {
  return useSyncExternalStore(onNetworkChange, isOnline);
}
