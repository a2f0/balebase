export type ContractPdfState<T> =
  | { status: "loading"; request: number }
  | { status: "loaded"; request: number; document: T }
  | { status: "failed"; request: number };

export type ContractPdfEvent<T> =
  | { type: "start"; request: number }
  | { type: "loaded"; request: number; document: T }
  | { type: "failed"; request: number };

/** Replacement loads invalidate earlier completions; failure is terminal. */
export function contractPdfReducer<T>(
  state: ContractPdfState<T>,
  event: ContractPdfEvent<T>,
): ContractPdfState<T> {
  switch (event.type) {
    case "start":
      return { status: "loading", request: event.request };
    case "loaded":
      return state.status === "loading" && state.request === event.request
        ? { status: "loaded", request: event.request, document: event.document }
        : state;
    case "failed":
      return state.status !== "failed" && state.request === event.request
        ? { status: "failed", request: event.request }
        : state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Duplicate/invalid page notifications cannot satisfy a complete review. */
export function recordRenderedPage(
  rendered: Set<number>,
  pageNumber: number,
  pageCount: number,
): boolean {
  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > pageCount ||
    rendered.has(pageNumber)
  ) {
    return false;
  }
  rendered.add(pageNumber);
  return rendered.size === pageCount;
}
