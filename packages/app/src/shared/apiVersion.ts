import { useSyncExternalStore } from "react";
import { balebase } from "../balebase";

/**
 * The API version the latest response named, or null until one does,
 * re-rendering when it changes, as it does after a deploy. A server render
 * reads it the same way.
 */
export function useApiVersion() {
  const { apiVersion } = balebase();
  const read = () => apiVersion.current;
  return useSyncExternalStore(apiVersion.subscribe, read, read);
}
