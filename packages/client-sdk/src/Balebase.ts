import { ApiClient } from "@balebase/api-client";
import type { BalebaseOptions } from "./BalebaseOptions";
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
  /** The device's connectivity. */
  readonly network: Network;

  constructor(options: BalebaseOptions = {}) {
    this.fetch = createApiFetch({
      apiVersion: this.apiVersion,
      fetch: options.fetch,
      nativeOrigin: options.nativeOrigin,
    });
    this.api = new ApiClient({
      baseUrl: options.apiBaseUrl ?? "",
      fetch: this.fetch,
    });
    this.network = new Network(options.network);
  }
}
