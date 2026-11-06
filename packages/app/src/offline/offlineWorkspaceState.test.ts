import { describe, expect, it } from "bun:test";
import type { OfflineWorkspace } from "./offlineStore";
import {
  initialOfflineWorkspace,
  type OfflineWorkspaceEvent,
  offlineWorkspaceError,
  offlineWorkspaceTransition,
} from "./offlineWorkspaceState";

const workspace = { projects: [] } as unknown as OfflineWorkspace;
const run = (...events: OfflineWorkspaceEvent[]) =>
  events.reduce(offlineWorkspaceTransition, initialOfflineWorkspace);
const started = (
  key: string | null,
  activation: number,
  request: number,
): OfflineWorkspaceEvent => ({
  activation,
  key,
  request,
  type: "loadStarted",
});
const syncFailed = (activation: number): OfflineWorkspaceEvent => ({
  activation,
  message: "Stuck.",
  type: "syncFailed",
});

describe("offline workspace state", () => {
  it("lands only the newest read", () => {
    const state = run(
      started("a", 1, 1),
      started("a", 1, 2),
      { request: 2, type: "loadLanded", workspace },
      { message: "Busy.", request: 1, type: "loadFailed" },
    );
    expect(state.workspace).toBe(workspace);
    expect(offlineWorkspaceError(state)).toBeUndefined();
  });

  it("clears a read's error when a newer read lands", () => {
    const state = run(
      started("a", 1, 1),
      { message: "Busy.", request: 1, type: "loadFailed" },
      started("a", 1, 2),
      { request: 2, type: "loadLanded", workspace },
    );
    expect(offlineWorkspaceError(state)).toBeUndefined();
  });

  it("keeps a sync error through reads of the same activation", () => {
    const state = run(started("a", 1, 1), syncFailed(1), started("a", 1, 2), {
      request: 2,
      type: "loadLanded",
      workspace,
    });
    expect(offlineWorkspaceError(state)).toBe("Stuck.");
    const synced = offlineWorkspaceTransition(state, {
      activation: 1,
      type: "syncSucceeded",
    });
    expect(offlineWorkspaceError(synced)).toBeUndefined();
  });

  it("drops errors and ignores earlier syncs after switching", () => {
    const switched = run(
      started("a", 1, 1),
      syncFailed(1),
      { message: "Busy.", request: 1, type: "loadFailed" },
      started("b", 2, 2),
      syncFailed(1),
    );
    expect(switched.key).toBe("b");
    expect(offlineWorkspaceError(switched)).toBeUndefined();
    const late = offlineWorkspaceTransition(switched, {
      activation: 1,
      type: "syncSucceeded",
    });
    expect(late).toBe(switched);
  });

  it("ignores a sync from before switching away and back", () => {
    // A, then B, then A again: the first activation's late failure is not
    // the third's.
    const back = run(
      started("a", 1, 1),
      started("b", 2, 2),
      started("a", 3, 3),
    );
    const stale = offlineWorkspaceTransition(back, syncFailed(1));
    expect(offlineWorkspaceError(stale)).toBeUndefined();
    const current = offlineWorkspaceTransition(back, syncFailed(3));
    expect(offlineWorkspaceError(current)).toBe("Stuck.");
  });
});
