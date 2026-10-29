import { afterEach, describe, expect, it } from "bun:test";
import { fetchApi } from "./apiVersion";
import { authCallbackUrl } from "./config";
import { configureHost } from "./host";
import { installFetch } from "./testing/fetch";

const respond = installFetch();

afterEach(() => configureHost({}));

const nativeHost = (origin: string) => ({
  native: {
    appUrl: "https://mobile-app.example",
    origin,
    saveFile: async () => true,
    savePassword: async () => {},
  },
});

async function sentHeaders(request: Request) {
  let headers = new Headers();
  respond(async (_url, init) => {
    headers = new Headers(init?.headers);
    return new Response("{}");
  });
  await fetchApi(request);
  return headers;
}

describe("host-dependent API requests", () => {
  it("uses the current web origin for browser email links", () => {
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

  it("sends the native shell's origin and preserves request headers", async () => {
    for (const origin of ["capacitor://localhost", "https://localhost"]) {
      configureHost(nativeHost(origin));
      const headers = await sentHeaders(
        new Request("https://api.test/api/me", {
          headers: { "X-Test": "preserved" },
        }),
      );
      expect(headers.get("X-Balebase-Native-Origin")).toBe(origin);
      expect(headers.get("X-Test")).toBe("preserved");
    }
  });

  it("sends no native marker from the browser", async () => {
    const headers = await sentHeaders(new Request("https://api.test/api/me"));
    expect(headers.has("X-Balebase-Native-Origin")).toBe(false);
  });

  it("keeps emailed links on the hosted app in a native shell", () => {
    configureHost(nativeHost("https://localhost"));
    expect(authCallbackUrl("/reset-password")).toBe(
      "https://mobile-app.example/reset-password",
    );
    expect(authCallbackUrl("/?verified=true")).toBe(
      "https://mobile-app.example/?verified=true",
    );
  });
});
