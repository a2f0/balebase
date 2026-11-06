/**
 * The Finance start switch's save. It shows the saved choice, or, while a
 * save is in flight, the choice being saved. Each save carries a request tag,
 * so a save the person no longer waits for (a newer one started, or the page
 * changed account) cannot finish into the current one.
 */
export type FinanceStartState =
  | { status: "idle" }
  | { request: number; status: "saving"; value: boolean }
  | { message: string; status: "failed" };

export type FinanceStartEvent =
  | { request: number; type: "saveStarted"; value: boolean }
  /** Saved, and the session that carries it reloaded. */
  | { request: number; type: "saveFinished" }
  | { message: string; request: number; type: "saveFailed" };

export const initialFinanceStart: FinanceStartState = { status: "idle" };

/** Transitions; a finish or failure for another request changes nothing. */
export function financeStartTransition(
  state: FinanceStartState,
  event: FinanceStartEvent,
): FinanceStartState {
  switch (event.type) {
    case "saveStarted":
      return state.status === "saving"
        ? state
        : { request: event.request, status: "saving", value: event.value };
    case "saveFinished":
      return current(state, event.request) ? initialFinanceStart : state;
    case "saveFailed":
      return current(state, event.request)
        ? { message: event.message, status: "failed" }
        : state;
    default:
      return unknownEvent(event);
  }
}

function current(state: FinanceStartState, request: number) {
  return state.status === "saving" && state.request === request;
}

/** The switch's position: the choice being saved, else the saved one. */
export function shownFinanceStart(state: FinanceStartState, saved: boolean) {
  return state.status === "saving" ? state.value : saved;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown Finance start event: ${JSON.stringify(event)}`);
}
