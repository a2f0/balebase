/**
 * Polling a connection's pending sync job. Each state names the job it
 * belongs to, so a failed poll's error lives only while that job is still the
 * pending one: once the job finishes, is cancelled (a disconnect), or another
 * takes its place, the error goes with it.
 */
export type SyncPollState =
  | { status: "idle" }
  | { job: string; status: "polling" }
  | { job: string; message: string; status: "failed" };

export type SyncPollEvent =
  /** The pending job the latest connection data shows, or null for none. */
  | { job: string | null; type: "pendingSeen" }
  | { job: string; type: "pollSucceeded" }
  | { job: string; message: string; type: "pollFailed" };

export const initialSyncPoll: SyncPollState = { status: "idle" };

const polled = (state: SyncPollState, job: string) =>
  state.status !== "idle" && state.job === job;

export function syncPollTransition(
  state: SyncPollState,
  event: SyncPollEvent,
): SyncPollState {
  switch (event.type) {
    case "pendingSeen":
      if (event.job === null)
        return state.status === "idle" ? state : initialSyncPoll;
      return polled(state, event.job)
        ? state
        : { job: event.job, status: "polling" };
    case "pollSucceeded":
      return state.status === "failed" && state.job === event.job
        ? { job: event.job, status: "polling" }
        : state;
    case "pollFailed":
      return polled(state, event.job)
        ? { job: event.job, message: event.message, status: "failed" }
        : state;
    default:
      return unknownEvent(event);
  }
}

/** The error to show, only while its job is still the pending one. */
export function syncPollError(state: SyncPollState) {
  return state.status === "failed" ? state.message : undefined;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown sync poll event: ${JSON.stringify(event)}`);
}
