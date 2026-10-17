import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Capacitor } from "@capacitor/core";
import { fetchApi } from "./apiVersion";
import { authCallbackUrl } from "./config";

let native = spyOn(Capacitor, "isNativePlatform");
let platform = spyOn(Capacitor, "getPlatform");

beforeEach(() => {
  native = spyOn(Capacitor, "isNativePlatform");
  platform = spyOn(Capacitor, "getPlatform");
});

afterEach(() => {
  native.mockRestore();
  platform.mockRestore();
});

describe("mobile API requests", () => {
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
      expect(requests.map((headers) => headers.get("Origin"))).toEqual([
        "capacitor://localhost",
        "https://localhost",
      ]);
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
    expect(authCallbackUrl("/reset-password")).toBe(
      "https://app.balebase.com/reset-password",
    );
    expect(authCallbackUrl("/?verified=true")).toBe(
      "https://app.balebase.com/?verified=true",
    );
  });
});
