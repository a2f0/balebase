import { describe, expect, it } from "bun:test";
import {
  initialKeptPage,
  type KeptPageEvent,
  type KeptPageState,
  keptPageTransition,
} from "./keptPageState";

const none: KeptPageState = { status: "none" };
const shown: KeptPageState = {
  entry: 1,
  pathname: "/list",
  status: "shown",
  visit: 0,
};
const hidden: KeptPageState = { ...shown, status: "hidden" };
const record: KeptPageEvent = { type: "recordShown" };
const page = (entry: number, pathname = "/list"): KeptPageEvent => ({
  entry,
  pathname,
  type: "pageShown",
});

describe("keptPageTransition", () => {
  it("starts with no page", () => {
    expect(initialKeptPage).toEqual(none);
  });

  it.each<[string, KeptPageState, KeptPageEvent, KeptPageState]>([
    ["shows the page first", none, page(1), shown],
    [
      "follows the page to another path",
      shown,
      page(2, "/list/filtered"),
      { ...shown, entry: 2, pathname: "/list/filtered" },
    ],
    ["hides the page beneath a record", shown, record, hidden],
    ["returns to the entry it was left on", hidden, page(1), shown],
    [
      "starts afresh from a link to it",
      hidden,
      page(3),
      { ...shown, entry: 3, visit: 1 },
    ],
    [
      "starts afresh at another path",
      hidden,
      page(1, "/other"),
      { ...shown, pathname: "/other", visit: 1 },
    ],
  ])("%s", (_name, state, event, next) => {
    expect(keptPageTransition(state, event)).toEqual(next);
  });

  it.each<[string, KeptPageState, KeptPageEvent]>([
    ["a record with no page yet", none, record],
    ["the page shown again where it is", shown, page(1)],
    ["another record over the hidden page", hidden, record],
  ])("keeps the same state for %s", (_name, state, event) => {
    expect(keptPageTransition(state, event)).toBe(state);
  });

  it("rejects an unknown event", () => {
    expect(() =>
      keptPageTransition(shown, { type: "unknown" } as never),
    ).toThrow("Unknown kept page event");
  });
});
