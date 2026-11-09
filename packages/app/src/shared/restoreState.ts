/**
 * Restoring a deleted record from its feature's deleted list.
 *
 * | State              | Event              | Next                         |
 * | ------------------ | ------------------ | ---------------------------- |
 * | `idle`, `failed`   | `restoreStarted`   | `restoring` with its request |
 * | `restoring`        | `restoreSucceeded` | `restored` with the record   |
 * | `restoring`        | `restoreFailed`    | `failed` with the error      |
 *
 * A result finishes only the request in flight. Entering `restored` opens
 * the record, so no restore starts after one succeeds. Any other event is
 * ignored: no second restore starts while one runs.
 */
export type RestoreState =
  | { status: "idle" }
  | { status: "restoring"; request: number }
  | { status: "restored"; id: string }
  | { status: "failed"; error: string };

export type RestoreEvent =
  | { type: "restoreStarted"; request: number }
  | { type: "restoreSucceeded"; request: number; id: string }
  | { type: "restoreFailed"; request: number; error: string };

export const initialRestore: RestoreState = { status: "idle" };

export function restoreTransition(
  state: RestoreState,
  event: RestoreEvent,
): RestoreState {
  switch (event.type) {
    case "restoreStarted":
      return state.status === "idle" || state.status === "failed"
        ? { status: "restoring", request: event.request }
        : state;
    case "restoreSucceeded":
      return state.status === "restoring" && state.request === event.request
        ? { status: "restored", id: event.id }
        : state;
    case "restoreFailed":
      return state.status === "restoring" && state.request === event.request
        ? { status: "failed", error: event.error }
        : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown restore event: ${JSON.stringify(event)}`);
}
