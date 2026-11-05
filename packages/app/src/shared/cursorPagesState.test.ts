import { describe, expect, it } from "bun:test";
import {
  type CursorList,
  type CursorPagesEvent,
  type CursorPagesState,
  cursorPagesTransition,
  initialCursorPages,
} from "./cursorPagesState";

type State = CursorPagesState<string>;
type Event = CursorPagesEvent<string>;

const list: CursorList<string> = {
  generation: 1,
  items: ["a"],
  nextCursor: "next",
};
const last: CursorList<string> = { ...list, nextCursor: null };
const page = { items: ["b"], nextCursor: null };

function run(state: State, ...events: Event[]) {
  return events.reduce<State>(cursorPagesTransition, state);
}

describe("cursorPagesTransition", () => {
  it.each<[string, State, Event, State]>([
    [
      "starts the first page",
      initialCursorPages,
      { type: "refresh", request: 1, clear: true },
      { status: "refreshing", request: 1, list: undefined },
    ],
    [
      "keeps the list while it refreshes",
      { status: "idle", list },
      { type: "refresh", request: 2, clear: false },
      { status: "refreshing", request: 2, list },
    ],
    [
      "clears the list for a different one",
      { status: "idle", list },
      { type: "refresh", request: 2, clear: true },
      { status: "refreshing", request: 2, list: undefined },
    ],
    [
      "replaces a later page with a refresh",
      { status: "loadingMore", request: 2, list },
      { type: "refresh", request: 3, clear: false },
      { status: "refreshing", request: 3, list },
    ],
    [
      "shows the first page as a new generation",
      { status: "refreshing", request: 4, list },
      { type: "firstPage", request: 4, page },
      { status: "idle", list: { ...page, generation: 4 } },
    ],
    [
      "starts a later page",
      { status: "idle", list },
      { type: "loadMore", request: 2 },
      { status: "loadingMore", request: 2, list },
    ],
    [
      "appends a later page",
      { status: "loadingMore", request: 2, list },
      { type: "nextPage", request: 2, page },
      {
        status: "idle",
        list: { generation: 1, items: ["a", "b"], nextCursor: null },
      },
    ],
    [
      "keeps the list when a refresh fails",
      { status: "refreshing", request: 2, list },
      { type: "failed", request: 2, error: "Offline" },
      { status: "idle", list, error: "Offline" },
    ],
    [
      "keeps the list when a later page fails",
      { status: "loadingMore", request: 2, list },
      { type: "failed", request: 2, error: "Offline" },
      { status: "idle", list, error: "Offline" },
    ],
  ])("%s", (_, state, event, next) => {
    expect(cursorPagesTransition(state, event)).toEqual(next);
  });

  it.each<[string, State, Event]>([
    [
      "a later page during a refresh",
      { status: "refreshing", request: 2, list },
      { type: "loadMore", request: 3 },
    ],
    [
      "a second later page",
      { status: "loadingMore", request: 2, list },
      { type: "loadMore", request: 3 },
    ],
    [
      "a later page after the last",
      { status: "idle", list: last },
      { type: "loadMore", request: 2 },
    ],
    [
      "a later page before any list",
      initialCursorPages,
      { type: "loadMore", request: 1 },
    ],
    [
      "a first page while idle",
      { status: "idle", list },
      { type: "firstPage", request: 1, page },
    ],
    [
      "a replaced first page",
      { status: "refreshing", request: 3, list },
      { type: "firstPage", request: 2, page },
    ],
    [
      "a later page during a refresh's first page",
      { status: "refreshing", request: 3, list },
      { type: "nextPage", request: 2, page },
    ],
    [
      "another request's later page",
      { status: "loadingMore", request: 3, list },
      { type: "nextPage", request: 2, page },
    ],
    [
      "a first page while a later page loads",
      { status: "loadingMore", request: 3, list },
      { type: "firstPage", request: 3, page },
    ],
    [
      "a failure while idle",
      { status: "idle", list },
      { type: "failed", request: 1, error: "Offline" },
    ],
    [
      "a replaced request's failure",
      { status: "refreshing", request: 3, list },
      { type: "failed", request: 2, error: "Offline" },
    ],
  ])("ignores %s", (_, state, event) => {
    expect(cursorPagesTransition(state, event)).toBe(state);
  });

  it("lets only the newest first page finish after a reset", () => {
    // start(A) -> reset (a different list) -> start(B) -> succeed(A)
    const replaced = run(
      initialCursorPages,
      { type: "refresh", request: 1, clear: true },
      { type: "refresh", request: 2, clear: true },
      {
        type: "firstPage",
        request: 1,
        page: { items: ["old"], nextCursor: "x" },
      },
    );
    expect(replaced).toEqual({
      status: "refreshing",
      request: 2,
      list: undefined,
    });
    expect(run(replaced, { type: "firstPage", request: 2, page })).toEqual({
      status: "idle",
      list: { ...page, generation: 2 },
    });
  });

  it("drops a later page requested before a refresh", () => {
    const state = run(
      { status: "idle", list },
      { type: "loadMore", request: 2 },
      { type: "refresh", request: 3, clear: false },
      {
        type: "nextPage",
        request: 2,
        page: { items: ["stale"], nextCursor: null },
      },
      { type: "failed", request: 2, error: "Offline" },
    );
    expect(state).toEqual({ status: "refreshing", request: 3, list });
  });

  it("never shows an error while a request is in flight", () => {
    const failed: State = { status: "idle", list, error: "Offline" };
    for (const event of [
      { type: "refresh", request: 2, clear: false },
      { type: "loadMore", request: 2 },
    ] satisfies Event[]) {
      expect(cursorPagesTransition(failed, event)).not.toHaveProperty("error");
    }
  });
});
