/**
 * One business row's mode. A row shows its summary, its inline editor, or a
 * delete in flight, never two at once: the editor cannot open over a delete,
 * and a delete cannot start from the editor.
 */
export type BusinessRowState =
  | { status: "viewing" }
  | { status: "editing" }
  | { status: "deleting" };

export type BusinessRowEvent =
  | { type: "editOpened" }
  /** Cancelled, or saved: the list holds the updated business. */
  | { type: "editClosed" }
  /** The deletion was confirmed and its request sent. */
  | { type: "deleteStarted" }
  | { type: "deleteFailed" };

export const initialBusinessRow: BusinessRowState = { status: "viewing" };

/**
 * The row's transitions. Events that do not apply in the current mode leave
 * it unchanged. A successful delete needs no event: the list drops the row.
 */
export function businessRowTransition(
  state: BusinessRowState,
  event: BusinessRowEvent,
): BusinessRowState {
  switch (event.type) {
    case "editOpened":
      return state.status === "viewing" ? { status: "editing" } : state;
    case "editClosed":
      return state.status === "editing" ? initialBusinessRow : state;
    case "deleteStarted":
      return state.status === "viewing" ? { status: "deleting" } : state;
    case "deleteFailed":
      return state.status === "deleting" ? initialBusinessRow : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown business row event: ${JSON.stringify(event)}`);
}
