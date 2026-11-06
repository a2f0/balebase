import { expect, it, mock } from "bun:test";
import type { PluginListenerHandle } from "@capacitor/core";
import type { ConnectionStatus } from "@capacitor/network";
import { capacitorNetwork } from "./network";

/** A native Network plugin starting at `initial`; `emit` sends a change. */
function nativePlugin(initial: ConnectionStatus) {
  let listener: ((status: ConnectionStatus) => void) | undefined;
  const plugin = {
    addListener: mock(
      async (
        _event: "networkStatusChange",
        callback: (status: ConnectionStatus) => void,
      ) => {
        listener = callback;
        return { remove: async () => {} } as PluginListenerHandle;
      },
    ),
    getStatus: mock(async () => initial),
  };
  return { emit: (status: ConnectionStatus) => listener?.(status), plugin };
}

it("follows the OS, counting any active transport as online", async () => {
  const { emit, plugin } = nativePlugin({
    connected: false,
    connectionType: "none",
  });
  const network = capacitorNetwork(plugin, true);
  const seen: boolean[] = [];
  network.subscribe((online) => seen.push(online));
  // Optimistic until the first native read.
  expect(seen).toEqual([]);
  await Bun.sleep(0);
  expect(network.getOnline()).toBe(false);
  // Android's unvalidated network: a transport without `connected`.
  emit({ connected: false, connectionType: "wifi" });
  emit({ connected: true, connectionType: "cellular" });
  emit({ connected: false, connectionType: "none" });
  expect(seen).toEqual([false, true, false]);
  // A second subscriber binds nothing again.
  network.subscribe(() => {});
  expect(plugin.addListener).toHaveBeenCalledTimes(1);
});

it("stays online when the native plugin is missing", async () => {
  const { plugin } = nativePlugin({ connected: false, connectionType: "none" });
  const network = capacitorNetwork(plugin, false);
  network.subscribe(() => {});
  await Bun.sleep(0);
  expect(network.getOnline()).toBe(true);
  expect(plugin.getStatus).not.toHaveBeenCalled();
});

it("keeps a change event over a startup reading that lands after it", async () => {
  const reading = Promise.withResolvers<ConnectionStatus>();
  const { emit, plugin } = nativePlugin({
    connected: true,
    connectionType: "wifi",
  });
  plugin.getStatus.mockImplementation(() => reading.promise);
  const network = capacitorNetwork(plugin, true);
  const seen: boolean[] = [];
  network.subscribe((online) => seen.push(online));
  await Bun.sleep(0);
  // The connection drops while the startup reading is still on its way.
  emit({ connected: false, connectionType: "none" });
  reading.resolve({ connected: true, connectionType: "wifi" });
  await Bun.sleep(0);
  expect(network.getOnline()).toBe(false);
  expect(seen).toEqual([false]);
});
