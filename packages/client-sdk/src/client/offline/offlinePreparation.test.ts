import { afterEach, beforeEach, expect, it } from "bun:test";
import { ApiClient } from "@balebase/api-client";
import type { OfflineWorkspace } from "../../data/offline/offlineWorkspace";
import { Network } from "../runtime/network";
import { Offline } from ".";
import type { OfflineStore } from "./offlineStore";

const identity = {
  organizationName: "Team",
  scope: { organizationId: "org", userId: "user" },
  user: { email: "person@example.com", id: "user", name: "Person" },
};
const locks = Object.getOwnPropertyDescriptor(navigator, "locks");

beforeEach(() => {
  // Bun has no Web Locks; preparing a device requires them.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, work: () => Promise<unknown>) => work(),
    },
  });
});

afterEach(() => {
  if (locks) Object.defineProperty(navigator, "locks", locks);
  else Reflect.deleteProperty(navigator, "locks");
});

/** An `Offline` over a recording store and API, with the given shell wait. */
function offline(waitForOfflineShell?: () => Promise<void>) {
  const calls: string[] = [];
  const store = {
    accessEpoch: () => "epoch",
    activate: () => calls.push("activate"),
    change: async (
      _key: string,
      change: (workspace: OfflineWorkspace | undefined) => OfflineWorkspace,
    ) => {
      calls.push("change");
      return change(undefined);
    },
    emptyWorkspace: (): OfflineWorkspace => ({
      ...identity,
      forms: [],
      issues: [],
      jobs: [],
      key: "key",
      members: [],
      projects: [],
      templates: [],
    }),
    read: async () => undefined,
    scopeKey: () => "key",
  } as unknown as OfflineStore;
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async () => {
      calls.push("request");
      return Response.json({ changed: false });
    },
  });
  const network = new Network({
    getOnline: () => true,
    subscribe: () => () => undefined,
  });
  return {
    calls,
    offline: new Offline({ api, network, store, waitForOfflineShell }),
  };
}

it("stores nothing until the host can reopen offline", async () => {
  let ready = () => {};
  const { calls, offline: device } = offline(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const pulling = device.pull(identity, "epoch");
  await Promise.resolve();
  expect(calls).toEqual([]);
  ready();
  expect(await pulling).toBe(false);
  expect(calls).toEqual(["change", "activate", "request"]);
});

it("stores and requests nothing when the host cannot reopen offline", async () => {
  const { calls, offline: device } = offline(() =>
    Promise.reject(new Error("No service worker.")),
  );
  const failure = await device
    .pull(identity, "epoch")
    .catch((cause: unknown) => cause);
  expect(failure).toEqual(new Error("No service worker."));
  expect(calls).toEqual([]);
});

it("prepares at once for hosts that always reopen", async () => {
  const { calls, offline: device } = offline();
  expect(await device.pull(identity, "epoch")).toBe(false);
  expect(calls).toEqual(["change", "activate", "request"]);
});
