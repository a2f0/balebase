import { ApiClient } from "@balebase/api-client";
import type { BalebaseOptions } from "./BalebaseOptions";
import {
  type BalebaseAuthClient,
  createBalebaseAuthClient,
} from "./client/auth/authClient";
import { FinanceCache } from "./client/finance";
import { Offline } from "./client/offline";
import { OfflineStore } from "./client/offline/offlineStore";
import {
  type ApiFetch,
  type ApiKeyScope,
  createApiFetch,
} from "./client/runtime/apiFetch";
import { ApiVersion } from "./client/runtime/apiVersion";
import { Network } from "./client/runtime/network";

/**
 * The Balebase client runtime, without React: the typed API and the state
 * that outlives a screen. A host makes one with its platform's services and
 * reads everything through it.
 */
export class Balebase {
  /** Every API route, typed by the shared contract. */
  readonly api: ApiClient;
  /** The version of the API that answered last. */
  readonly apiVersion = new ApiVersion();
  /**
   * `fetch` for API URLs outside the typed routes, such as files a page shows
   * or downloads. Like every typed call, it marks a native shell's requests
   * and records the API version.
   */
  readonly fetch: ApiFetch;
  /** The transactions this device keeps for Finance. */
  readonly financeCache: FinanceCache;
  /** The device's connectivity. */
  readonly network: Network;
  /** Forms and issues done on this device, and the queue that syncs them. */
  readonly offline: Offline;
  readonly #apiBaseUrl: string;
  #auth: BalebaseAuthClient | undefined;
  readonly #authFetch: ApiFetch;

  constructor(options: BalebaseOptions = {}) {
    // One spelling, since saved data on the device is keyed by it.
    const apiBaseUrl = (options.apiBaseUrl ?? "").replace(/\/+$/, "");
    if (!apiBaseUrl && typeof location === "undefined") {
      throw new Error(
        "Set apiBaseUrl: outside a browser there is no page origin to send API requests to.",
      );
    }
    if (apiBaseUrl && !isApiBase(apiBaseUrl)) {
      throw new Error(
        // Not echoed: the value may hold credentials.
        "apiBaseUrl must be an http(s) URL with no query or credentials, such as https://api.balebase.com.",
      );
    }
    // A key read from a file can end in a newline, which no header allows.
    const apiKey = options.apiKey?.trim();
    if (apiKey === "")
      throw new Error("apiKey is blank: pass an API key, or leave it unset.");
    const transport = {
      apiVersion: this.apiVersion,
      fetch: options.fetch,
      nativeOrigin: options.nativeOrigin,
    };
    this.fetch = createApiFetch({
      ...transport,
      apiKey:
        apiKey === undefined ? undefined : apiKeyScope(apiBaseUrl, apiKey),
    });
    // `fetch` withholds the key from Better Auth's routes too; the auth
    // client never holds it at all, whatever URLs it builds.
    this.#authFetch = createApiFetch({ ...transport, apiKey: undefined });
    this.#apiBaseUrl = apiBaseUrl;
    this.api = new ApiClient({ baseUrl: apiBaseUrl, fetch: this.fetch });
    this.financeCache = new FinanceCache(apiBaseUrl);
    this.network = new Network(options.network);
    this.offline = new Offline({
      api: this.api,
      network: this.network,
      store: new OfflineStore(apiBaseUrl),
      waitForOfflineShell: options.waitForOfflineShell,
    });
  }

  /**
   * The Better Auth client: sign-in, sessions, two-factor, and
   * organizations. Made on first use; its requests mark a native shell and
   * record the API version like `fetch`, but never carry `apiKey`, since
   * those routes are session-only. It watches the session (focus,
   * connectivity, other tabs) only while something reads `useSession`;
   * Better Auth stops that shortly after the last reader leaves.
   */
  get auth(): BalebaseAuthClient {
    this.#auth ??= createBalebaseAuthClient(this.#apiBaseUrl, this.#authFetch);
    return this.#auth;
  }
}

/**
 * Whether route paths can be appended to `url`: an http(s) URL with no
 * credentials, query, or fragment. A path, as behind a proxy, is kept, and
 * so is the spelling, which keys saved data. "localhost:8787" parses too,
 * with "localhost:" as its scheme, so the scheme is checked.
 */
function isApiBase(url: string) {
  try {
    const { hash, password, protocol, search, username } = new URL(url);
    return (
      /^https?:$/.test(protocol) && !username && !password && !search && !hash
    );
  } catch {
    return false;
  }
}

/**
 * Where an API key may go: under `apiBaseUrl`, or the page's origin without
 * one. Refuses a page that is not served over http(s), such as a file://
 * page, a srcdoc or data: frame, or a custom scheme, whose origin names no
 * web host to limit the key to (browsers spell it "null", "file://", or the
 * scheme's). Refuses a base the key would cross the network to unencrypted.
 * Outside a browser, apiBaseUrl is set (`Balebase` checks first), and it is
 * always http(s).
 */
function apiKeyScope(apiBaseUrl: string, value: string): ApiKeyScope {
  const base = apiBaseUrl || location.origin;
  const url = base === "null" ? undefined : new URL(base);
  if (url === undefined || !/^https?:$/.test(url.protocol))
    throw new Error(
      "Set apiBaseUrl to use apiKey: this page is not served over http(s) (as for a file:// page, a srcdoc or data: frame, or a custom scheme), so the key has no API origin to go to.",
    );
  // https, or http to a loopback address, as a local API is.
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "apiKey needs an https apiBaseUrl, or http to localhost, 127.0.0.1, or [::1]: over http elsewhere the key would cross the network unencrypted.",
    );
  return { origin: url.origin, path: url.pathname.replace(/\/$/, ""), value };
}
