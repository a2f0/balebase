import { ApiClient } from "@balebase/api-client";
import type { BalebaseOptions } from "./BalebaseOptions";
import {
  type BalebaseAuthClient,
  createBalebaseAuthClient,
} from "./client/auth/authClient";
import { FinanceCache } from "./client/finance";
import { Offline } from "./client/offline";
import { OfflineStore } from "./client/offline/offlineStore";
import { type ApiFetch, createApiFetch } from "./client/runtime/apiFetch";
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
    if (apiBaseUrl && !isWebOrigin(apiBaseUrl)) {
      throw new Error(
        `apiBaseUrl must be an http(s) origin, such as https://api.balebase.com, with no path, not "${apiBaseUrl}".`,
      );
    }
    const { apiKey } = options;
    if (apiKey !== undefined && !apiKey.trim())
      throw new Error("apiKey is blank: pass an API key, or leave it unset.");
    if (apiKey !== undefined && !sendsSecretsSafely(apiBaseUrl))
      throw new Error(
        "apiKey needs an https apiBaseUrl: over http the key would cross the network unencrypted.",
      );
    const transport = {
      apiVersion: this.apiVersion,
      fetch: options.fetch,
      nativeOrigin: options.nativeOrigin,
    };
    this.fetch = createApiFetch({
      ...transport,
      apiKey:
        apiKey === undefined
          ? undefined
          : // Outside a browser, apiBaseUrl is set (checked above).
            {
              origin: new URL(apiBaseUrl || location.origin).origin,
              value: apiKey,
            },
    });
    // Better Auth's routes are session-only, so they never get the key.
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
 * Whether `url` is an http(s) origin with nothing after it. "localhost:8787"
 * parses too, with "localhost:" as its scheme, so the scheme is checked.
 */
function isWebOrigin(url: string) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.origin === url;
  } catch {
    return false;
  }
}

/**
 * Whether a secret sent to `apiBaseUrl` stays encrypted or on this machine:
 * https, or http to a loopback address, as a local API is. Without one the
 * page's origin is the API's, and pages are not given keys.
 */
function sendsSecretsSafely(apiBaseUrl: string) {
  if (!apiBaseUrl) return true;
  const { hostname, protocol } = new URL(apiBaseUrl);
  return (
    protocol === "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  );
}
