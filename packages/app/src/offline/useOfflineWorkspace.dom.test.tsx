import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import {
  activateOfflineWorkspace,
  type OfflineWorkspace,
} from "./offlineStore";
import {
  type OfflineWorkspaceStorage,
  useOfflineWorkspace,
} from "./useOfflineWorkspace";

const { mount, settle } = installDom({
  globals: (window) => ({ localStorage: window.localStorage }),
  url: "http://localhost:5173/offline",
});

const workspace = { projects: [] } as unknown as OfflineWorkspace;

/** Storage whose every read and sync waits for the test to settle it. */
function heldStorage() {
  const reads: Array<PromiseWithResolvers<OfflineWorkspace | undefined>> = [];
  const syncs: Array<PromiseWithResolvers<boolean>> = [];
  const storage: OfflineWorkspaceStorage = {
    read: () => {
      const read = Promise.withResolvers<OfflineWorkspace | undefined>();
      reads.push(read);
      return read.promise;
    },
    sync: () => {
      const sync = Promise.withResolvers<boolean>();
      syncs.push(sync);
      return sync.promise;
    },
  };
  return { reads, storage, syncs };
}

let latest: ReturnType<typeof useOfflineWorkspace> | undefined;
let storage: OfflineWorkspaceStorage | undefined;

function Harness() {
  if (!storage) throw new Error("No storage");
  latest = useOfflineWorkspace(storage);
  return null;
}

async function mountWorkspace(held: OfflineWorkspaceStorage) {
  storage = held;
  // Active before mounting, so the first refresh reads and syncs it.
  activateOfflineWorkspace("user-1:org-1");
  await mount(<Harness />);
  return () => {
    if (!latest) throw new Error("Not mounted");
    return latest;
  };
}

async function settleWith<T>(
  pending: PromiseWithResolvers<T> | undefined,
  outcome: { error: Error } | { value: T },
) {
  if (!pending) throw new Error("Nothing pending");
  await act(async () => {
    if ("error" in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
    await settle();
  });
}

afterEach(() => localStorage.clear());

describe("offline workspace", () => {
  it("keeps an older read's failure off newer data", async () => {
    const held = heldStorage();
    const view = await mountWorkspace(held.storage);
    expect(held.reads).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    expect(held.reads).toHaveLength(2);
    await settleWith(held.reads[1], { value: workspace });
    await settleWith(held.reads[0], { error: new Error("Storage busy.") });
    expect(view().workspace).toBe(workspace);
    expect(view().error).toBeUndefined();
  });

  it("keeps a failing sync's error after a read lands", async () => {
    const held = heldStorage();
    const view = await mountWorkspace(held.storage);
    await settleWith(held.syncs[0], { error: new Error("Queue stuck.") });
    expect(view().error).toBe("Queue stuck.");
    await settleWith(held.reads[0], { value: workspace });
    expect(view().error).toBe("Queue stuck.");
    // The next sync that succeeds clears it.
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await settleWith(held.syncs[1], { value: true });
    expect(view().error).toBeUndefined();
  });

  it("keeps a running sync's failure over a skipped one", async () => {
    const held = heldStorage();
    const view = await mountWorkspace(held.storage);
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    // The second drain found the first holding the lock, so it skipped.
    await settleWith(held.syncs[1], { value: false });
    await settleWith(held.syncs[0], { error: new Error("Queue stuck.") });
    expect(view().error).toBe("Queue stuck.");
  });

  it("keeps a sync's failure when a later drain is skipped", async () => {
    const held = heldStorage();
    const view = await mountWorkspace(held.storage);
    await settleWith(held.syncs[0], { error: new Error("Queue stuck.") });
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    // Another tab holds the lock, so this drain skipped; nothing was sent.
    await settleWith(held.syncs[1], { value: false });
    expect(view().error).toBe("Queue stuck.");
  });

  it("drops the last workspace's sync error on switching", async () => {
    const held = heldStorage();
    const view = await mountWorkspace(held.storage);
    await settleWith(held.syncs[0], { error: new Error("Queue stuck.") });
    expect(view().error).toBe("Queue stuck.");
    await act(async () => {
      activateOfflineWorkspace("user-1:org-2");
    });
    expect(view().error).toBeUndefined();
  });
});
