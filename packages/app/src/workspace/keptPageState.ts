/**
 * The page a section keeps beneath its record pages. There is none until the
 * section first shows it (it may open at a record), or once it is discarded.
 * Hidden beneath a record, it remembers the history entry it was left on:
 * only Back or Forward to that entry returns to it as it was, while a link to
 * the page starts it afresh. `visit` names each fresh start, and the page
 * mounts anew when it changes; `none` holds the next one.
 */
export type KeptPageState =
  | { status: "none"; visit: number }
  | ({ status: "shown" } & KeptPage)
  | ({ status: "hidden" } & KeptPage);

interface KeptPage {
  /** The ID of the history entry that showed the page last. */
  entry: string;
  pathname: string;
  visit: number;
}

export type KeptPageEvent =
  /** The section shows its page for `pathname` at history entry `entry`. */
  | { type: "pageShown"; entry: string; pathname: string }
  /** The section shows a record page. */
  | { type: "recordShown" }
  /** What the hidden page shows may no longer be shown, such as data whose
   * access ended. A page on screen handles that itself. */
  | { type: "pageDiscarded" };

export const initialKeptPage: KeptPageState = { status: "none", visit: 0 };

/**
 * The kept page's transitions. Events that change nothing return the same
 * state, so a render can apply them without looping.
 */
export function keptPageTransition(
  state: KeptPageState,
  event: KeptPageEvent,
): KeptPageState {
  switch (event.type) {
    case "recordShown":
      return state.status === "shown" ? { ...state, status: "hidden" } : state;
    case "pageShown": {
      const { entry, pathname } = event;
      if (state.status === "none")
        return { entry, pathname, status: "shown", visit: state.visit };
      const same = state.entry === entry && state.pathname === pathname;
      if (state.status === "shown")
        // The page moved within itself, such as to another filter's path.
        return same ? state : { ...state, entry, pathname };
      return same
        ? { ...state, status: "shown" }
        : { entry, pathname, status: "shown", visit: state.visit + 1 };
    }
    case "pageDiscarded":
      return state.status === "hidden"
        ? { status: "none", visit: state.visit + 1 }
        : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown kept page event: ${JSON.stringify(event)}`);
}
