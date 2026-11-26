import type { ApiClient } from "@balebase/client-sdk";

/**
 * The state of one job run's details (`useRunDetail` in `AdminJobRun.tsx`):
 * its output and a page of its logs, read again while the run is queued or
 * running.
 *
 * | State                | Event        | Next                                   |
 * | -------------------- | ------------ | -------------------------------------- |
 * | any                  | `opened`     | `loading`: another run or page         |
 * | `loading`, `failed`  | `retried`    | `loading`                              |
 * | `loaded`             | `retried`    | `loaded`, details kept, error cleared  |
 * | any                  | `read`       | `loaded` with the details read         |
 * | `loading`, `failed`  | `readFailed` | `failed` with the error                |
 * | `loaded`             | `readFailed` | `loaded` with the error, details kept  |
 *
 * Each read of a run's page carries the tag of the request that started it.
 * A read or failure finishes only the current request, so one from a run or
 * page the admin has left, or from a request a retry replaced, is ignored.
 */
export type RunDetail = Awaited<ReturnType<ApiClient["adminJobs"]["detail"]>>;

export type RunDetailState =
  /** Reading a run's page, with nothing of it to show yet. */
  | { status: "loading"; request: number }
  /** The page could not be read, and nothing of it has been. */
  | { status: "failed"; request: number; error: string }
  /** The page as last read; `error` names a later read that failed. */
  | { status: "loaded"; request: number; detail: RunDetail; error?: string };

export type RunDetailEvent =
  /** Another run or page opened: what showed belongs to the last one. */
  | { type: "opened"; request: number }
  /** The same page is read again on request; what it shows stays. */
  | { type: "retried"; request: number }
  | { type: "read"; request: number; detail: RunDetail }
  | { type: "readFailed"; request: number; error: string };

export const initialRunDetail: RunDetailState = {
  status: "loading",
  request: 0,
};

export function runDetailTransition(
  state: RunDetailState,
  event: RunDetailEvent,
): RunDetailState {
  switch (event.type) {
    case "opened":
      return { status: "loading", request: event.request };
    case "retried":
      return state.status === "loaded"
        ? { status: "loaded", request: event.request, detail: state.detail }
        : { status: "loading", request: event.request };
    case "read":
      return state.request === event.request
        ? { status: "loaded", request: event.request, detail: event.detail }
        : state;
    case "readFailed":
      if (state.request !== event.request) return state;
      return state.status === "loaded"
        ? { ...state, error: event.error }
        : { status: "failed", request: event.request, error: event.error };
    default:
      return unhandled(event);
  }
}

function unhandled(event: never): never {
  throw new Error(`Unhandled run detail event: ${JSON.stringify(event)}`);
}
