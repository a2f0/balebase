import { useSyncExternalStore } from "react";
import { balebase } from "../balebase";

/** Whether the device has a network, re-rendering when it changes. */
export function useOnline() {
  const { network } = balebase();
  return useSyncExternalStore(network.subscribe, () => network.online);
}
