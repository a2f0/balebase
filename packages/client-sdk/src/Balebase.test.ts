import { afterEach, describe, expect, it } from "bun:test";
import { Balebase } from "./Balebase";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const apiBaseUrl = "https://api.test";

/** Runs `use` as a page would, with `origin` as its location. */
async function onPage(origin: string, use: () => Promise<void>) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(origin),
  });
  try {
    await use();
  } finally {
    Reflect.deleteProperty(globalThis, "location");
  }
}

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
    const balebase = new Balebase({ apiBaseUrl, fetch });
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

  it("sends a page's API key only to the page's origin without an API origin", async () => {
    // Keys never belong in a page; this covers only how the API's origin is
    // found without apiBaseUrl. Bun cannot build a Request for a relative
    // URL, so read what was sent.
    const sent: (string | null)[] = [];
    await onPage("https://app.test", async () => {
      const balebase = new Balebase({
        apiKey: "tlk_test_key",
        fetch: async (_input, init) => {
          sent.push(new Headers(init?.headers).get("Authorization"));
          return Response.json({});
        },
      });
      await balebase.fetch("/api/me");
      await balebase.fetch("https://app.test/api/me");
      await balebase.fetch("https://api.test/api/me");
    });
    expect(sent).toEqual(["Bearer tlk_test_key", "Bearer tlk_test_key", null]);
  });

  it("refuses a blank API key, such as an environment variable set empty", () => {
    for (const apiKey of ["", "  "]) {
      expect(() => new Balebase({ apiBaseUrl, apiKey })).toThrow(
        "apiKey is blank",
      );
    }
  });

  it("refuses an API origin that is not an absolute URL", () => {
    for (const apiBaseUrl of ["api.balebase.com", "/api"]) {
      expect(() => new Balebase({ apiBaseUrl })).toThrow(
        "apiBaseUrl must be an absolute URL",
      );
    }
  });

  it("refuses to start outside a browser without an API origin", () => {
    for (const missing of [undefined, "", "/"]) {
      expect(() => new Balebase({ apiBaseUrl: missing })).toThrow(
        "Set apiBaseUrl: outside a browser there is no page origin",
      );
    }
  });

  it("looks the global fetch up per request when given no transport", async () => {
    const balebase = new Balebase({ apiBaseUrl });
    const { fetch, sent } = recordRequests();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    await balebase.fetch("https://api.test/api/objects/1");
    expect(sent).toHaveLength(1);
  });

  it("sends a native shell's origin and preserves request headers", async () => {
    for (const nativeOrigin of ["capacitor://localhost", "https://localhost"]) {
      const { fetch, sent } = recordRequests();
      const balebase = new Balebase({ apiBaseUrl, fetch, nativeOrigin });
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
    await new Balebase({ apiBaseUrl, fetch }).fetch(
      new Request("https://api.test/api/me"),
    );
    expect(sent[0]?.headers.has("X-Balebase-Native-Origin")).toBe(false);
    expect(sent[0]?.headers.has("Authorization")).toBe(false);
  });

  it("sends an API key as a bearer token with every request", async () => {
    const { fetch, sent } = recordRequests(() => Response.json({ user: null }));
    const balebase = new Balebase({
      apiBaseUrl,
      apiKey: "tlk_test_key",
      fetch,
      nativeOrigin: "https://localhost",
    });
    await balebase.api.session.me();
    await balebase.fetch(
      new Request("https://api.test/api/objects/1", {
        headers: { "X-Test": "preserved" },
      }),
    );
    await balebase.auth.getSession();
    // A request that names its own credentials keeps them.
    await balebase.fetch("https://api.test/api/me", {
      headers: { Authorization: "Bearer tlk_other_key" },
    });
    // Another origin, such as a presigned upload, never sees the key.
    await balebase.fetch("https://uploads.example.test/api/me");
    await balebase.fetch(new URL("http://api.test/api/me"));
    await balebase.fetch("https://api.test:8443/api/me");
    expect(sent.map(({ headers }) => headers.get("Authorization"))).toEqual([
      "Bearer tlk_test_key",
      "Bearer tlk_test_key",
      "Bearer tlk_test_key",
      "Bearer tlk_other_key",
      null,
      null,
      null,
    ]);
    expect(sent[1]?.headers.get("X-Test")).toBe("preserved");
    for (const { headers } of sent) {
      expect(headers.get("X-Balebase-Native-Origin")).toBe("https://localhost");
    }
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

  it("sends auth calls to the page's origin, like typed calls, without one", async () => {
    const sent: string[] = [];
    await onPage("https://app.test", async () => {
      const balebase = new Balebase({
        fetch: async (input) => {
          sent.push(input instanceof Request ? input.url : String(input));
          return Response.json(null);
        },
      });
      await balebase.api.session.me();
      await balebase.auth.getSession();
    });
    expect(sent).toEqual(["/api/me", "/api/auth/get-session"]);
  });
});

describe("API version", () => {
  it("keeps the version the latest response named, whatever its status", async () => {
    let headers: HeadersInit = { "API-Version": "41" };
    let status = 200;
    const { fetch } = recordRequests(() =>
      Response.json({ error: "No." }, { headers, status }),
    );
    const balebase = new Balebase({ apiBaseUrl, fetch });
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
      apiBaseUrl,
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
    const { network } = new Balebase({ apiBaseUrl });
    expect(network.online).toBe(true);
    network.subscribe(() => {
      throw new Error("A headless source never changes.");
    })();
  });
});
