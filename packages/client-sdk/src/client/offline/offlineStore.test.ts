import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OfflineStore } from "./offlineStore";

const api = "https://api.test";
const pointer = `balebase:offline:${api}`;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let items: Map<string, string>;
let failing: boolean;
// Stores for one API share this tab's subscribers; each test drops its own.
const unsubscribes: (() => void)[] = [];

function useStorage() {
  const fail = () => {
    if (failing)
      throw new DOMException("Storage is full.", "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(name: string) {
        fail();
        return items.get(name) ?? null;
      },
      removeItem(name: string) {
        fail();
        items.delete(name);
      },
      setItem(name: string, value: string) {
        fail();
        items.set(name, value);
      },
    },
  });
}

beforeEach(() => {
  items = new Map();
  failing = false;
  useStorage();
});

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function watched() {
  const store = new OfflineStore(api);
  const changes = { count: 0 };
  unsubscribes.push(
    store.subscribe(() => {
      changes.count += 1;
    }),
  );
  return { changes, store };
}

describe("offline store", () => {
  it("keeps the key shapes devices already hold work under", () => {
    const store = new OfflineStore(api);
    const key = store.scopeKey({ organizationId: "org", userId: "user" });
    expect(key).toBe(JSON.stringify([api, "user", "org"]));
    store.activate(key);
    expect(items.get(pointer)).toBe(key);
    expect(store.activeKey()).toBe(key);
    store.lock();
    expect(items.has(pointer)).toBe(false);
    expect(items.get(`${pointer}:epoch`)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an identity confirmed before the device locked", () => {
    const { changes, store } = watched();
    const epoch = store.accessEpoch();
    store.lock();
    expect(store.accessEpoch()).not.toBe(epoch);
    expect(() => store.activate("key", epoch)).toThrow(
      "The active account changed. Reload before syncing.",
    );
    expect(store.activeKey()).toBeNull();
    store.activate("key", store.accessEpoch());
    expect(store.activeKey()).toBe("key");
    expect(changes.count).toBe(2);
  });

  it("sees a lock from another tab through the shared epoch", () => {
    const store = new OfflineStore(api);
    const epoch = store.accessEpoch();
    items.set(`${pointer}:epoch`, "another tab");
    expect(store.accessEpoch()).not.toBe(epoch);
  });

  const active = JSON.stringify([api, "user", "org"]);
  it.each([
    ["the same person and organization", active, "user", "org", false],
    ["the same person, any organization", active, "user", undefined, false],
    ["another person", active, "other", "org", true],
    ["another organization", active, "user", "other", true],
    [
      "another API",
      JSON.stringify(["https://other.test", "user", "org"]),
      "user",
      "org",
      true,
    ],
    ["an unreadable pointer", "{", "user", "org", true],
    [
      "a pointer that is not a scope",
      JSON.stringify({ user: "user" }),
      "user",
      "org",
      true,
    ],
  ] as const)(
    "on %s, lockOther locks: %s",
    (_, key, userId, organizationId, locks) => {
      items.set(pointer, key);
      const { changes, store } = watched();
      store.lockOther(userId, organizationId);
      expect(store.activeKey()).toBe(locks ? null : key);
      expect(changes.count).toBe(locks ? 1 : 0);
    },
  );

  it("leaves a device with no active workspace alone", () => {
    const { changes, store } = watched();
    store.lockOther("user", "org");
    expect(changes.count).toBe(0);
  });

  it("still locks this tab when storage fails", () => {
    const { changes, store } = watched();
    const epoch = store.accessEpoch();
    failing = true;
    expect(store.activeKey()).toBeNull();
    store.lock();
    expect(store.accessEpoch()).not.toBe(epoch);
    expect(changes.count).toBe(1);
  });

  it("shares this tab's locks and notices between stores for one API", () => {
    const { changes, store: first } = watched();
    const epoch = first.accessEpoch();
    failing = true;
    // A second SDK, as after a host change, sees the first one's lock.
    const second = new OfflineStore(api);
    second.lock();
    expect(first.accessEpoch()).not.toBe(epoch);
    expect(new OfflineStore(api).accessEpoch()).toBe(second.accessEpoch());
    expect(changes.count).toBe(1);
    // Another API's stores keep their own.
    const other = new OfflineStore("https://other.test");
    const otherEpoch = other.accessEpoch();
    second.lock();
    expect(other.accessEpoch()).toBe(otherEpoch);
  });

  it("reports a subscriber's error without failing the lock", () => {
    const reported: unknown[] = [];
    const report = globalThis.reportError;
    globalThis.reportError = (cause) => reported.push(cause);
    try {
      const store = new OfflineStore(api);
      const broken = new Error("listener broke");
      unsubscribes.push(
        store.subscribe(() => {
          throw broken;
        }),
      );
      const { changes } = watched();
      items.set(pointer, "key");
      expect(() => store.lock()).not.toThrow();
      expect(store.activeKey()).toBeNull();
      expect(changes.count).toBe(1);
      expect(reported).toEqual([broken]);
    } finally {
      globalThis.reportError = report;
    }
  });

  it("stops telling a subscriber once it unsubscribes", () => {
    const store = new OfflineStore(api);
    let count = 0;
    const stop = store.subscribe(() => {
      count += 1;
    });
    store.lock();
    stop();
    store.lock();
    expect(count).toBe(1);
  });
});
