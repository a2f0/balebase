import { describe, expect, it } from "bun:test";
import {
  initialRestore,
  type RestoreEvent,
  type RestoreState,
  restoreTransition,
} from "./restoreState";

const idle: RestoreState = { status: "idle" };
const restoring: RestoreState = { request: 1, status: "restoring" };
const restored: RestoreState = { id: "laptop", status: "restored" };
const failed: RestoreState = { error: "Gone.", status: "failed" };

function run(state: RestoreState, ...events: RestoreEvent[]) {
  return events.reduce(restoreTransition, state);
}

describe("restoreTransition", () => {
  it("starts idle", () => {
    expect(initialRestore).toEqual(idle);
  });

  it.each<[string, RestoreState, RestoreEvent, RestoreState]>([
    [
      "starts a restore",
      idle,
      { request: 1, type: "restoreStarted" },
      restoring,
    ],
    [
      "retries after a failure",
      failed,
      { request: 2, type: "restoreStarted" },
      { request: 2, status: "restoring" },
    ],
    [
      "finishes the restore in flight",
      restoring,
      { id: "laptop", request: 1, type: "restoreSucceeded" },
      restored,
    ],
    [
      "fails the restore in flight",
      restoring,
      { error: "Gone.", request: 1, type: "restoreFailed" },
      failed,
    ],
  ])("%s", (_name, state, event, next) => {
    expect(restoreTransition(state, event)).toEqual(next);
  });

  it.each<[string, RestoreState, RestoreEvent]>([
    ["a second restore", restoring, { request: 2, type: "restoreStarted" }],
    [
      "a restore once one succeeded",
      restored,
      { request: 2, type: "restoreStarted" },
    ],
    [
      "another request's success",
      restoring,
      { id: "monitor", request: 2, type: "restoreSucceeded" },
    ],
    [
      "another request's failure",
      restoring,
      { error: "Gone.", request: 2, type: "restoreFailed" },
    ],
    [
      "a success with nothing in flight",
      idle,
      { id: "laptop", request: 1, type: "restoreSucceeded" },
    ],
    [
      "a failure after the record opened",
      restored,
      { error: "Gone.", request: 1, type: "restoreFailed" },
    ],
  ])("ignores %s", (_name, state, event) => {
    expect(restoreTransition(state, event)).toBe(state);
  });

  it("lets only the latest request finish after a retry", () => {
    expect(
      run(
        idle,
        { request: 1, type: "restoreStarted" },
        { error: "Gone.", request: 1, type: "restoreFailed" },
        { request: 2, type: "restoreStarted" },
        { id: "laptop", request: 1, type: "restoreSucceeded" },
      ),
    ).toEqual({ request: 2, status: "restoring" });
  });

  it("rejects an unknown event", () => {
    expect(() => restoreTransition(idle, { type: "unknown" } as never)).toThrow(
      "Unknown restore event",
    );
  });
});
