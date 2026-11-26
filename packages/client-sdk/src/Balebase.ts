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

  constructor(options: BalebaseOptions = {}) {
    // One spelling, since saved data on the device is keyed by it.
    const apiBaseUrl = (options.apiBaseUrl ?? "").replace(/\/+$/, "");
    if (!apiBaseUrl && typeof location === "undefined") {
      throw new Error(
        "Set apiBaseUrl: outside a browser there is no page origin to send API requests to.",
      );
    }
    this.fetch = createApiFetch({
      apiKey: options.apiKey,
      apiVersion: this.apiVersion,
      fetch: options.fetch,
      nativeOrigin: options.nativeOrigin,
    });
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
   * organizations. Made on first use, since it starts watching the session
   * (focus, other tabs) as soon as it exists.
   */
  get auth(): BalebaseAuthClient {
    this.#auth ??= createBalebaseAuthClient(this.#apiBaseUrl, this.fetch);
    return this.#auth;
  }
}
