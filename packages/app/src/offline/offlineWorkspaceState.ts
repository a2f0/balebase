import type { OfflineWorkspace } from "./offlineStore";

/**
 * The device workspace view: the workspace last read and the errors from
 * reading and syncing it, all for one active workspace key. A different key
 * resets the errors, and results for another key, or from a read newer
 * reads replaced, never land.
 */
export interface OfflineWorkspaceState {
  key: string | null;
  /** The newest read started; only it may land. */
  load: number;
  loadError: string | undefined;
  syncError: string | undefined;
  workspace: OfflineWorkspace | undefined;
}

export type OfflineWorkspaceEvent =
  | { key: string | null; request: number; type: "loadStarted" }
  | {
      request: number;
      type: "loadLanded";
      workspace: OfflineWorkspace | undefined;
    }
  | { message: string; request: number; type: "loadFailed" }
  /** A drain that ran for `key`; skipped drains report nothing. */
  | { key: string; type: "syncSucceeded" }
  | { key: string; message: string; type: "syncFailed" };

export const initialOfflineWorkspace: OfflineWorkspaceState = {
  key: null,
  load: 0,
  loadError: undefined,
  syncError: undefined,
  workspace: undefined,
};

export function offlineWorkspaceTransition(
  state: OfflineWorkspaceState,
  event: OfflineWorkspaceEvent,
): OfflineWorkspaceState {
  switch (event.type) {
    case "loadStarted":
      return event.key === state.key
        ? { ...state, load: event.request }
        : {
            ...state,
            key: event.key,
            load: event.request,
            loadError: undefined,
            syncError: undefined,
          };
    case "loadLanded":
      return event.request === state.load
        ? { ...state, loadError: undefined, workspace: event.workspace }
        : state;
    case "loadFailed":
      return event.request === state.load
        ? { ...state, loadError: event.message }
        : state;
    case "syncSucceeded":
      return event.key === state.key
        ? { ...state, syncError: undefined }
        : state;
    case "syncFailed":
      return event.key === state.key
        ? { ...state, syncError: event.message }
        : state;
    default:
      return unknownEvent(event);
  }
}

/** The error to show: a failed read first, then a failing sync. */
export function offlineWorkspaceError(state: OfflineWorkspaceState) {
  return state.loadError ?? state.syncError;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown offline workspace event: ${JSON.stringify(event)}`);
}
