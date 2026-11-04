import type { NetworkStatusSource } from "@balebase/app/host";
import { Capacitor } from "@capacitor/core";
import { type ConnectionStatus, Network } from "@capacitor/network";

// @capacitor/network sets `connected` from Android's internet validation,
// which is false on networks Android has not validated (captive portals, some
// VPNs) and before validation finishes at launch, even while the connection
// works. Any active transport counts as online; a network with no internet
// shows up as a failed sync instead of a misleading "offline".
function isConnected(status: ConnectionStatus) {
  return status.connected || status.connectionType !== "none";
}

/**
 * Connectivity from the OS (ConnectivityManager on Android, NWPathMonitor on
 * iOS) rather than the WebView's `navigator.onLine`, which an Android WebView
 * can report as false while the device is connected. Native reads are
 * asynchronous, so it starts online and the first status corrects it.
 *
 * Without the native plugin (stripped from a build), @capacitor/network falls
 * back to `navigator.onLine`, the value this replaces, so the source keeps
 * its online start instead: an unreachable API still fails its requests.
 */
export function capacitorNetwork(
  plugin: Pick<typeof Network, "addListener" | "getStatus"> = Network,
  native = Capacitor.isPluginAvailable("Network"),
): NetworkStatusSource {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  let bound = false;

  function update(next: boolean) {
    if (next === online) return;
    online = next;
    for (const listener of listeners) listener(online);
  }

  function bind() {
    if (bound || !native) return;
    bound = true;
    void plugin
      .getStatus()
      .then((status) => update(isConnected(status)))
      .catch(() => undefined);
    void plugin.addListener("networkStatusChange", (status) =>
      update(isConnected(status)),
    );
  }

  return {
    getOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      bind();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
