import type { OfflineWorkspace } from "./offlineStore";

/**
 * The device workspace view: the workspace last read and the errors from
 * reading and syncing it, all for one activation of a workspace. Each time
 * the active key changes (even back to an earlier one) is a new activation:
 * it resets the errors, and results from another activation, or from a read
 * newer reads replaced, never land.
 */
export interface OfflineWorkspaceState {
  activation: number;
  key: string | null;
  /** The newest read started; only it may land. */
  load: number;
  loadError: string | undefined;
  syncError: string | undefined;
  workspace: OfflineWorkspace | undefined;
}

export type OfflineWorkspaceEvent =
  | {
      activation: number;
      key: string | null;
      request: number;
      type: "loadStarted";
    }
  | {
      request: number;
      type: "loadLanded";
      workspace: OfflineWorkspace | undefined;
    }
  | { message: string; request: number; type: "loadFailed" }
  /** A drain that ran, in `activation`; skipped drains report nothing. */
  | { activation: number; type: "syncSucceeded" }
  | { activation: number; message: string; type: "syncFailed" };

export const initialOfflineWorkspace: OfflineWorkspaceState = {
  activation: 0,
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
      return event.activation === state.activation
        ? { ...state, load: event.request }
        : {
            ...state,
            activation: event.activation,
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
      return event.activation === state.activation
        ? { ...state, syncError: undefined }
        : state;
    case "syncFailed":
      return event.activation === state.activation
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
