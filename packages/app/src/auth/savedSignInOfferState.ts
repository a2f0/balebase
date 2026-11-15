/**
 * Offering the system's saved sign-ins on one sign-in page: once, when the
 * sign-in form first shows. Only that request may fill the form, and only
 * until the person moves on without it. Moving on ends the offer for good, so
 * a second system sheet never opens over one still pending.
 */
export type SavedSignInOfferState =
  | { status: "waiting" }
  | { status: "asking"; request: number }
  | { status: "done" };

export type SavedSignInOfferEvent =
  | { type: "signInShown"; request: number }
  /** The person left sign-in or submitted it before an answer arrived. */
  | { type: "abandoned" }
  /** Chosen, dismissed, none saved, or failed: each ends the offer. */
  | { type: "answered"; request: number };

export const initialSavedSignInOffer: SavedSignInOfferState = {
  status: "waiting",
};

const done: SavedSignInOfferState = { status: "done" };

/**
 * The offer's transitions. Events that do not apply leave the state unchanged,
 * so a caller can tell from a changed state that its event took effect.
 */
export function savedSignInOfferTransition(
  state: SavedSignInOfferState,
  event: SavedSignInOfferEvent,
): SavedSignInOfferState {
  switch (event.type) {
    case "signInShown":
      return state.status === "waiting"
        ? { status: "asking", request: event.request }
        : state;
    case "abandoned":
      return state.status === "asking" ? done : state;
    case "answered":
      return state.status === "asking" && state.request === event.request
        ? done
        : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(
    `Unknown saved sign-in offer event: ${JSON.stringify(event)}`,
  );
}
