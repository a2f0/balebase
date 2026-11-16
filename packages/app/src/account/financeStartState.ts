/**
 * A Finance start choice's save (a switch, or the period). It shows the saved
 * choice, or, while a save is in flight, the choice being saved. Each save
 * carries a request tag, so a save the person no longer waits for (a newer
 * one started, or the page changed account) cannot finish into the current
 * one.
 */
export type FinanceStartState<Value> =
  | { status: "idle" }
  | { request: number; status: "saving"; value: Value }
  | { message: string; status: "failed" };

export type FinanceStartEvent<Value> =
  | { request: number; type: "saveStarted"; value: Value }
  /** Saved, and the session that carries it reloaded. */
  | { request: number; type: "saveFinished" }
  | { message: string; request: number; type: "saveFailed" };

export const initialFinanceStart: FinanceStartState<never> = {
  status: "idle",
};

/** Transitions; a finish or failure for another request changes nothing. */
export function financeStartTransition<Value>(
  state: FinanceStartState<Value>,
  event: FinanceStartEvent<Value>,
): FinanceStartState<Value> {
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

function current(state: FinanceStartState<unknown>, request: number) {
  return state.status === "saving" && state.request === request;
}

/** The control's value: the choice being saved, else the saved one. */
export function shownFinanceStart<Value>(
  state: FinanceStartState<Value>,
  saved: Value,
) {
  return state.status === "saving" ? state.value : saved;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown Finance start event: ${JSON.stringify(event)}`);
}
