import type { ApiFetch } from "./client/runtime/apiFetch";
import type { NetworkStatusSource } from "./client/runtime/network";

/** What a host passes to `new Balebase(options)`; every field is optional. */
export interface BalebaseOptions {
  /**
   * The API origin, such as `https://api.balebase.com`, without a trailing
   * slash or `/api`. Defaults to the page's own origin; outside a browser,
   * where relative URLs cannot be fetched, set it.
   */
  apiBaseUrl?: string | undefined;
  /**
   * Sends each request. Defaults to the global `fetch`, looked up per call.
   * Outside a browser it must supply the authentication a browser's session
   * cookie would.
   */
  fetch?: ApiFetch | undefined;
  /**
   * A native shell's WebView origin, sent with every request as
   * `X-Balebase-Native-Origin`. Leave it unset in a browser: the marker is not
   * authentication, and the API ignores it when a browser Origin is present.
   */
  nativeOrigin?: string | undefined;
  /** Device connectivity; defaults to the browser's. */
  network?: NetworkStatusSource | undefined;
}
