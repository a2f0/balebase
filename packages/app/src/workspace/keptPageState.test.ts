import { describe, expect, it } from "bun:test";
import {
  initialKeptPage,
  type KeptPageEvent,
  type KeptPageState,
  keptPageTransition,
} from "./keptPageState";

const none: KeptPageState = { status: "none", visit: 0 };
const shown: KeptPageState = {
  entry: "a",
  pathname: "/list",
  status: "shown",
  visit: 0,
};
const hidden: KeptPageState = { ...shown, status: "hidden" };
const record: KeptPageEvent = { type: "recordShown" };
const discarded: KeptPageEvent = { type: "pageDiscarded" };
const page = (entry: string, pathname = "/list"): KeptPageEvent => ({
  entry,
  pathname,
  type: "pageShown",
});

function run(state: KeptPageState, ...events: KeptPageEvent[]) {
  return events.reduce(keptPageTransition, state);
}

describe("keptPageTransition", () => {
  it("starts with no page", () => {
    expect(initialKeptPage).toEqual(none);
  });

  it.each<[string, KeptPageState, KeptPageEvent, KeptPageState]>([
    ["shows the page first", none, page("a"), shown],
    [
      "follows the page to another path",
      shown,
      page("b", "/list/filtered"),
      { ...shown, entry: "b", pathname: "/list/filtered" },
    ],
    ["hides the page beneath a record", shown, record, hidden],
    ["returns to the entry it was left on", hidden, page("a"), shown],
    [
      "starts afresh from a link to it",
      hidden,
      page("c"),
      { ...shown, entry: "c", visit: 1 },
    ],
    [
      "starts afresh at another path",
      hidden,
      page("a", "/other"),
      { ...shown, pathname: "/other", visit: 1 },
    ],
    ["discards the hidden page", hidden, discarded, { ...none, visit: 1 }],
  ])("%s", (_name, state, event, next) => {
    expect(keptPageTransition(state, event)).toEqual(next);
  });

  it.each<[string, KeptPageState, KeptPageEvent]>([
    ["a record with no page yet", none, record],
    ["a discard with no page", none, discarded],
    ["the page shown again where it is", shown, page("a")],
    ["a discard of the page on screen", shown, discarded],
    ["another record over the hidden page", hidden, record],
  ])("keeps the same state for %s", (_name, state, event) => {
    expect(keptPageTransition(state, event)).toBe(state);
  });

  it("starts a discarded page afresh even on the entry it was left on", () => {
    expect(run(hidden, discarded, record, page("a"))).toEqual({
      ...shown,
      visit: 1,
    });
  });

  it("rejects an unknown event", () => {
    expect(() =>
      keptPageTransition(shown, { type: "unknown" } as never),
    ).toThrow("Unknown kept page event");
  });
});
