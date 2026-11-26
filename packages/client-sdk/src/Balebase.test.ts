import { afterEach, describe, expect, it } from "bun:test";
import { Balebase } from "./Balebase";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with `reply`, keeping what was sent. */
function recordRequests(reply = () => Response.json({})) {
  const sent: { headers: Headers; url: string }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ headers: request.headers, url: request.url });
    return reply();
  };
  return { fetch, sent };
}

describe("API requests", () => {
  it("sends typed calls to the API origin", async () => {
    const user = { email: "sam@example.test", id: "u1", name: "Sam" };
    const { fetch, sent } = recordRequests(() => Response.json({ user }));
    const balebase = new Balebase({ apiBaseUrl: "https://api.test", fetch });
    expect(await balebase.api.session.me()).toEqual({ user });
    expect(sent.map(({ url }) => url)).toEqual(["https://api.test/api/me"]);
  });

  it("drops trailing slashes from the API origin, which keys saved data", async () => {
    const { fetch, sent } = recordRequests(() => Response.json({ user: null }));
    const balebase = new Balebase({ apiBaseUrl: "https://api.test//", fetch });
    await balebase.api.session.me();
    expect(sent.map(({ url }) => url)).toEqual(["https://api.test/api/me"]);
    expect(
      balebase.offline.scopeKey({ organizationId: "org", userId: "user" }),
    ).toBe(JSON.stringify(["https://api.test", "user", "org"]));
  });

  it("looks the global fetch up per request when given no transport", async () => {
    const balebase = new Balebase({ apiBaseUrl: "https://api.test" });
    const { fetch, sent } = recordRequests();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    await balebase.fetch("https://api.test/api/objects/1");
    expect(sent).toHaveLength(1);
  });

  it("sends a native shell's origin and preserves request headers", async () => {
    for (const nativeOrigin of ["capacitor://localhost", "https://localhost"]) {
      const { fetch, sent } = recordRequests();
      const balebase = new Balebase({ fetch, nativeOrigin });
      await balebase.fetch(
        new Request("https://api.test/api/me", {
          headers: { "X-Test": "preserved" },
        }),
      );
      await balebase.fetch("https://api.test/api/me", {
        headers: { "X-Test": "preserved" },
      });
      for (const { headers } of sent) {
        expect(headers.get("X-Balebase-Native-Origin")).toBe(nativeOrigin);
        expect(headers.get("X-Test")).toBe("preserved");
      }
    }
  });

  it("sends no native marker from a browser", async () => {
    const { fetch, sent } = recordRequests();
    await new Balebase({ fetch }).fetch(new Request("https://api.test/api/me"));
    expect(sent[0]?.headers.has("X-Balebase-Native-Origin")).toBe(false);
  });
});

describe("auth", () => {
  it("sends auth calls through the SDK's fetch to the API origin", async () => {
    const { fetch, sent } = recordRequests(() =>
      Response.json(null, { headers: { "API-Version": "9.9.9" } }),
    );
    const balebase = new Balebase({
      apiBaseUrl: "https://api.test/",
      fetch,
      nativeOrigin: "https://localhost",
    });
    expect(balebase.auth).toBe(balebase.auth);
    await balebase.auth.getSession();
    expect(sent.map(({ url }) => url)).toEqual([
      "https://api.test/api/auth/get-session",
    ]);
    expect(sent[0]?.headers.get("X-Balebase-Native-Origin")).toBe(
      "https://localhost",
    );
    expect(balebase.apiVersion.current).toBe("9.9.9");
  });
});

describe("API version", () => {
  it("keeps the version the latest response named, whatever its status", async () => {
    let headers: HeadersInit = { "API-Version": "41" };
    let status = 200;
    const { fetch } = recordRequests(() =>
      Response.json({ error: "No." }, { headers, status }),
    );
    const balebase = new Balebase({ fetch });
    const changes: (string | null)[] = [];
    const stop = balebase.apiVersion.subscribe(() =>
      changes.push(balebase.apiVersion.current),
    );
    expect(balebase.apiVersion.current).toBeNull();

    await balebase.fetch("https://api.test/health");
    headers = { "API-Version": "42" };
    status = 500;
    await balebase.api.session.me().catch(() => undefined);
    // A proxy's response that names no version keeps the last one.
    headers = {};
    await balebase.fetch("https://api.test/health");
    headers = { "API-Version": "42" };
    await balebase.fetch("https://api.test/health");
    stop();
    headers = { "API-Version": "43" };
    await balebase.fetch("https://api.test/health");

    expect(changes).toEqual(["41", "42"]);
    expect(balebase.apiVersion.current).toBe("43");
  });
});

describe("network", () => {
  it("reads and follows the host's connectivity", () => {
    let listener: ((online: boolean) => void) | undefined;
    const balebase = new Balebase({
      network: {
        getOnline: () => false,
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    });
    expect(balebase.network.online).toBe(false);
    const seen: boolean[] = [];
    const stop = balebase.network.subscribe((online) => seen.push(online));
    listener?.(true);
    stop();
    expect(seen).toEqual([true]);
    expect(listener).toBeUndefined();
  });

  it("reports online outside a browser, where nothing can change it", () => {
    const { network } = new Balebase();
    expect(network.online).toBe(true);
    network.subscribe(() => {
      throw new Error("A headless source never changes.");
    })();
  });
});
