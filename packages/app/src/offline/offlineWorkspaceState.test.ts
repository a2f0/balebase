import { describe, expect, it } from "bun:test";
import type { OfflineWorkspace } from "./offlineStore";
import {
  initialOfflineWorkspace,
  type OfflineWorkspaceEvent,
  type OfflineWorkspaceState,
  offlineWorkspaceError,
  offlineWorkspaceTransition,
} from "./offlineWorkspaceState";

const workspace = { projects: [] } as unknown as OfflineWorkspace;
const run = (...events: OfflineWorkspaceEvent[]) =>
  events.reduce(offlineWorkspaceTransition, initialOfflineWorkspace);
const started = (
  key: string | null,
  request: number,
): OfflineWorkspaceEvent => ({
  key,
  request,
  type: "loadStarted",
});

describe("offline workspace state", () => {
  it("lands only the newest read", () => {
    const state = run(
      started("a", 1),
      started("a", 2),
      { request: 2, type: "loadLanded", workspace },
      { message: "Busy.", request: 1, type: "loadFailed" },
    );
    expect(state.workspace).toBe(workspace);
    expect(offlineWorkspaceError(state)).toBeUndefined();
  });

  it("clears a read's error when a newer read lands", () => {
    const state = run(
      started("a", 1),
      { message: "Busy.", request: 1, type: "loadFailed" },
      started("a", 2),
      { request: 2, type: "loadLanded", workspace },
    );
    expect(offlineWorkspaceError(state)).toBeUndefined();
  });

  it("keeps a sync error through reads of the same workspace", () => {
    const state = run(
      started("a", 1),
      { key: "a", message: "Stuck.", type: "syncFailed" },
      started("a", 2),
      { request: 2, type: "loadLanded", workspace },
    );
    expect(offlineWorkspaceError(state)).toBe("Stuck.");
    expect(
      offlineWorkspaceError(
        offlineWorkspaceTransition(state, { key: "a", type: "syncSucceeded" }),
      ),
    ).toBeUndefined();
  });

  it("drops errors and ignores the old workspace's syncs after switching", () => {
    const failed: OfflineWorkspaceState = run(
      started("a", 1),
      { key: "a", message: "Stuck.", type: "syncFailed" },
      { message: "Busy.", request: 1, type: "loadFailed" },
    );
    const switched = run(
      ...[
        started("a", 1),
        { key: "a", message: "Stuck.", type: "syncFailed" } as const,
        { message: "Busy.", request: 1, type: "loadFailed" } as const,
        started("b", 2),
        { key: "a", message: "Late.", type: "syncFailed" } as const,
      ],
    );
    expect(offlineWorkspaceError(failed)).toBe("Busy.");
    expect(switched.key).toBe("b");
    expect(offlineWorkspaceError(switched)).toBeUndefined();
    expect(
      offlineWorkspaceTransition(switched, { key: "a", type: "syncSucceeded" }),
    ).toBe(switched);
  });
});
