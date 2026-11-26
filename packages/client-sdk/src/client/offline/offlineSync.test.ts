import { afterEach, expect, it } from "bun:test";
import { Balebase } from "../../Balebase";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const key = JSON.stringify(["https://api.test", "user", "org"]);

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function sdk(online: boolean, activeKey: string | null) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) =>
        name === "balebase:offline:https://api.test" ? activeKey : null,
    },
  });
  const requests: string[] = [];
  const balebase = new Balebase({
    apiBaseUrl: "https://api.test",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response("{}");
    },
    network: { getOnline: () => online, subscribe: () => () => undefined },
  });
  return { offline: balebase.offline, requests };
}

it.each([
  ["offline", false, key],
  ["another workspace is active", true, JSON.stringify(["other"])],
  ["no workspace is active", true, null],
] as const)("skips a drain while %s", async (_, online, activeKey) => {
  const { offline, requests } = sdk(online, activeKey);
  expect(await offline.sync(key)).toBe(false);
  expect(requests).toEqual([]);
});

it("never drains without Web Locks to keep tabs from racing", async () => {
  const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  try {
    const { offline, requests } = sdk(true, key);
    expect(await offline.sync(key)).toBe(false);
    expect(requests).toEqual([]);
  } finally {
    if (locks) Object.defineProperty(navigator, "locks", locks);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
