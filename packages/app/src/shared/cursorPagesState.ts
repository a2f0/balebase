/**
 * The state of one cursor-paginated list (`useCursorPages`).
 *
 * | State         | Event       | Next                                       |
 * | ------------- | ----------- | ------------------------------------------ |
 * | any           | `refresh`   | `refreshing` (keeps the list unless `clear`) |
 * | `refreshing`  | `firstPage` | `idle` with the page as a new generation   |
 * | `idle`        | `loadMore`  | `loadingMore`, when the list has a cursor  |
 * | `loadingMore` | `nextPage`  | `idle` with the page appended              |
 * | `refreshing`, `loadingMore` | `failed` | `idle` with the error, list kept |
 *
 * Each request carries its own tag. A page or failure finishes only the
 * request in flight, so a page from a replaced first page, or a later page
 * requested before a refresh, is ignored when it arrives. Any other event is
 * ignored too: no later page loads during a refresh or another later page.
 */

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** A loaded list; `generation` is the tag of the first page that started it. */
export interface CursorList<T> extends CursorPage<T> {
  generation: number;
}

export type CursorPagesState<T> =
  | { status: "idle"; list: CursorList<T> | undefined; error?: string }
  | { status: "refreshing"; request: number; list: CursorList<T> | undefined }
  | { status: "loadingMore"; request: number; list: CursorList<T> };

export type CursorPagesEvent<T> =
  | { type: "refresh"; request: number; clear: boolean }
  | { type: "firstPage"; request: number; page: CursorPage<T> }
  | { type: "loadMore"; request: number }
  | { type: "nextPage"; request: number; page: CursorPage<T> }
  | { type: "failed"; request: number; error: string };

export const initialCursorPages = { status: "idle", list: undefined } as const;

export function cursorPagesTransition<T>(
  state: CursorPagesState<T>,
  event: CursorPagesEvent<T>,
): CursorPagesState<T> {
  switch (event.type) {
    case "refresh":
      return {
        status: "refreshing",
        request: event.request,
        list: event.clear ? undefined : state.list,
      };
    case "firstPage":
      return state.status === "refreshing" && state.request === event.request
        ? {
            status: "idle",
            list: { ...event.page, generation: event.request },
          }
        : state;
    case "loadMore":
      return state.status === "idle" && state.list?.nextCursor
        ? { status: "loadingMore", request: event.request, list: state.list }
        : state;
    case "nextPage":
      return state.status === "loadingMore" && state.request === event.request
        ? {
            status: "idle",
            list: {
              generation: state.list.generation,
              items: [...state.list.items, ...event.page.items],
              nextCursor: event.page.nextCursor,
            },
          }
        : state;
    case "failed":
      return state.status !== "idle" && state.request === event.request
        ? { status: "idle", list: state.list, error: event.error }
        : state;
    default:
      return unhandled(event);
  }
}

function unhandled(event: never): never {
  throw new Error(`Unhandled cursor page event: ${JSON.stringify(event)}`);
}
