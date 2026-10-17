import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from "bun:test";
import { Capacitor } from "@capacitor/core";
import { fetchApi } from "./apiVersion";
import { authCallbackUrl } from "./config";

let native: Mock<typeof Capacitor.isNativePlatform>;
let platform: Mock<typeof Capacitor.getPlatform>;

beforeEach(() => {
  native = spyOn(Capacitor, "isNativePlatform");
  platform = spyOn(Capacitor, "getPlatform");
});

afterEach(() => {
  native.mockRestore();
  platform.mockRestore();
});

describe("mobile API requests", () => {
  it("uses the current web origin for browser email links", () => {
    native.mockReturnValue(false);
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://web.example" } },
    });
    try {
      expect(authCallbackUrl("/reset-password")).toBe(
        "https://web.example/reset-password",
      );
    } finally {
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("sends trusted native origins and preserves request headers", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Headers[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(new Headers(init?.headers));
      return new Response("{}");
    }) as typeof fetch;
    try {
      native.mockReturnValue(true);
      for (const os of ["ios", "android"]) {
        platform.mockReturnValue(os);
        await fetchApi(
          new Request("https://api.test/api/me", {
            headers: { "X-Test": "preserved" },
          }),
        );
      }
      expect(
        requests.map((headers) => headers.get("X-Balebase-Native-Origin")),
      ).toEqual(["capacitor://localhost", "https://localhost"]);
      expect(requests.map((headers) => headers.get("X-Test"))).toEqual([
        "preserved",
        "preserved",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps emailed links on the hosted app", () => {
    native.mockReturnValue(true);
    const { VITE_APP_URL } = process.env;
    Reflect.set(process.env, "VITE_APP_URL", "https://mobile-app.example");
    try {
      expect(authCallbackUrl("/reset-password")).toBe(
        "https://mobile-app.example/reset-password",
      );
      expect(authCallbackUrl("/?verified=true")).toBe(
        "https://mobile-app.example/?verified=true",
      );
    } finally {
      if (VITE_APP_URL === undefined)
        Reflect.deleteProperty(process.env, "VITE_APP_URL");
      else Reflect.set(process.env, "VITE_APP_URL", VITE_APP_URL);
    }
  });
});
