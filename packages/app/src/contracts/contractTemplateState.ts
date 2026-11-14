import { useCallback, useEffect, useReducer, useRef } from "react";

export type TemplateRequestState<T> =
  | { status: "idle" }
  | { status: "pending"; request: number; run: () => Promise<T> }
  | { status: "succeeded"; request: number; result: T }
  | { status: "failed"; request: number; error: string };

export type TemplateRequestEvent<T> =
  | { type: "start"; request: number; run: () => Promise<T> }
  | { type: "succeeded"; request: number; result: T }
  | { type: "failed"; request: number; error: string }
  | { type: "reset" };

/** Only the active request can finish. Reset invalidates every old completion. */
export function templateRequestReducer<T>(
  state: TemplateRequestState<T>,
  event: TemplateRequestEvent<T>,
): TemplateRequestState<T> {
  switch (event.type) {
    case "start":
      return state.status === "pending"
        ? state
        : { status: "pending", request: event.request, run: event.run };
    case "reset":
      return { status: "idle" };
    case "succeeded":
      return state.status === "pending" && state.request === event.request
        ? { status: "succeeded", request: event.request, result: event.result }
        : state;
    case "failed":
      return state.status === "pending" && state.request === event.request
        ? { status: "failed", request: event.request, error: event.error }
        : state;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** Effect replay subscribes to one mutation, never submits it twice. */
export function useTemplateRequest<T>(onSuccess?: (result: T) => void) {
  const [state, dispatch] = useReducer(templateRequestReducer<T>, {
    status: "idle",
  });
  const sequence = useRef(0);
  const callback = useRef(onSuccess);
  callback.current = onSuccess;
  const pending = useRef<{
    request: number;
    promise: Promise<T>;
    notified: boolean;
  } | null>(null);
  useEffect(() => {
    if (state.status !== "pending") return;
    if (pending.current?.request !== state.request) {
      pending.current = {
        request: state.request,
        promise: Promise.resolve().then(state.run),
        notified: false,
      };
    }
    const work = pending.current;
    let active = true;
    void work.promise.then(
      (result) => {
        if (!active || work.notified) return;
        work.notified = true;
        dispatch({ type: "succeeded", request: state.request, result });
        callback.current?.(result);
      },
      (cause: unknown) => {
        if (!active || work.notified) return;
        work.notified = true;
        dispatch({
          type: "failed",
          request: state.request,
          error:
            cause instanceof Error
              ? cause.message
              : "Could not update the template.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [state]);
  const start = useCallback((run: () => Promise<T>) => {
    dispatch({ type: "start", request: ++sequence.current, run });
  }, []);
  return {
    state,
    busy: state.status === "pending",
    error: state.status === "failed" ? state.error : undefined,
    start,
  };
}
