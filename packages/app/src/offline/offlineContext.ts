import { createContext, useContext } from "react";
import type { OfflineWorkspace } from "./offlineStore";

/** This device's workspace, as `useOfflineWorkspace` reads it in the App. */
export interface DeviceState {
  error: string | undefined;
  online: boolean;
  workspace: OfflineWorkspace | undefined;
}

/**
 * Pages read the device workspace the App keeps loaded and syncing, so only
 * one reader polls storage and sends queued work. Outside the App (tests of
 * one page) there is no workspace.
 */
export const DeviceContext = createContext<DeviceState>({
  error: undefined,
  online: true,
  workspace: undefined,
});

export function useDevice() {
  return useContext(DeviceContext);
}
