import { describe, expect, it } from "bun:test";
import {
  initialSavedSignInOffer,
  type SavedSignInOfferEvent,
  type SavedSignInOfferState,
  savedSignInOfferTransition,
} from "./savedSignInOfferState";

const waiting: SavedSignInOfferState = { status: "waiting" };
const asking: SavedSignInOfferState = { status: "asking", request: 1 };
const done: SavedSignInOfferState = { status: "done" };

function run(state: SavedSignInOfferState, ...events: SavedSignInOfferEvent[]) {
  return events.reduce(savedSignInOfferTransition, state);
}

describe("savedSignInOfferTransition", () => {
  it("waits for the sign-in form", () => {
    expect(initialSavedSignInOffer).toEqual(waiting);
  });

  it.each<
    [
      string,
      SavedSignInOfferState,
      SavedSignInOfferEvent,
      SavedSignInOfferState,
    ]
  >([
    [
      "asks when sign-in shows",
      waiting,
      { type: "signInShown", request: 1 },
      asking,
    ],
    ["ends with its answer", asking, { type: "answered", request: 1 }, done],
    ["ends when abandoned", asking, { type: "abandoned" }, done],
  ])("%s", (_name, state, event, next) => {
    expect(savedSignInOfferTransition(state, event)).toEqual(next);
  });

  it.each<[string, SavedSignInOfferState, SavedSignInOfferEvent]>([
    ["leaving before sign-in shows", waiting, { type: "abandoned" }],
    ["an answer never asked for", waiting, { type: "answered", request: 1 }],
    ["a second ask", asking, { type: "signInShown", request: 2 }],
    ["another request's answer", asking, { type: "answered", request: 2 }],
    ["sign-in showing again", done, { type: "signInShown", request: 2 }],
    ["an answer after moving on", done, { type: "answered", request: 1 }],
    ["moving on again", done, { type: "abandoned" }],
  ])("ignores %s", (_name, state, event) => {
    expect(savedSignInOfferTransition(state, event)).toBe(state);
  });

  it("never asks twice on one page", () => {
    // StrictMode replays the effect that shows sign-in; leaving and returning
    // shows it again. Neither may open a second sheet.
    expect(
      run(
        waiting,
        { type: "signInShown", request: 1 },
        { type: "signInShown", request: 2 },
        { type: "answered", request: 1 },
      ),
    ).toEqual(done);
    expect(
      run(
        waiting,
        { type: "signInShown", request: 1 },
        { type: "abandoned" },
        { type: "signInShown", request: 2 },
      ),
    ).toEqual(done);
  });

  it("rejects an unknown event", () => {
    expect(() =>
      savedSignInOfferTransition(waiting, { type: "unknown" } as never),
    ).toThrow("Unknown saved sign-in offer event");
  });
});
