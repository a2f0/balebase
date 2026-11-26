import type { ApiFetch } from "./client/runtime/apiFetch";
import type { NetworkStatusSource } from "./client/runtime/network";

/**
 * What a host passes to `new Balebase(options)`. In a browser every field is
 * optional; elsewhere `apiBaseUrl` is required.
 */
export interface BalebaseOptions {
  /**
   * The API origin, such as `https://api.balebase.com`, without a trailing
   * slash or `/api`, a query, or credentials; a path in front of the API's
   * own, as behind a proxy, is kept. Defaults to the page's own origin.
   * Outside a browser, where there is no page and relative URLs cannot be
   * fetched, it is required: `new Balebase` throws without it.
   */
  apiBaseUrl?: string | undefined;
  /**
   * An organization API key, for scripts and servers that have no browser
   * session. It is sent as a bearer token with every request under
   * `apiBaseUrl` (its origin and any proxy path), never to another host or
   * path, and never to Better Auth's session-only routes under `/api/auth`,
   * however they are sent or spelled. A redirect within the API's origin
   * keeps it, as `fetch` does; one to another origin drops it. It needs an
   * https `apiBaseUrl` (or http to this machine); a page whose origin names
   * no host, such as a file:// page, must set one. The key's access and the
   * routes API keys may reach still apply. It is a secret: never put one in
   * a page or an app others can open.
   */
  apiKey?: string | undefined;
  /**
   * Sends each request. Defaults to the global `fetch`, looked up per call.
   * Outside a browser, without `apiKey`, it must supply the authentication a
   * browser's session cookie would.
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
  /**
   * Resolves once the host can reopen without a connection, such as a web
   * app's service worker taking control; rejects when it cannot. Preparing a
   * device for offline work waits for it, so no work is stored that the
   * device could not reopen. Hosts that always reopen leave it unset.
   */
  waitForOfflineShell?: (() => Promise<void>) | undefined;
}
