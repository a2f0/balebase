import type { ApiVersion } from "./apiVersion";

/** `fetch`'s signature, for the transport the SDK sends API requests with. */
export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * An API key and where it may go: the API's origin, under the path in front
 * of the API's routes (empty, or a proxy's, such as `/balebase`).
 */
export interface ApiKeyScope {
  origin: string;
  path: string;
  value: string;
}

interface ApiFetchOptions {
  /**
   * Sent only to URLs under the API's base, so a file or link on another host
   * or path never sees it, and never to Better Auth's session-only routes.
   */
  apiKey: ApiKeyScope | undefined;
  apiVersion: ApiVersion;
  fetch: ApiFetch | undefined;
  nativeOrigin: string | undefined;
}

/**
 * `fetch` to the API: sends the host's API key to the API's routes, marks a
 * native shell's requests with its origin, and records the version each
 * response names.
 * With no transport given it looks the global `fetch` up per call, so a test
 * or shell that replaces it later is still the one used.
 */
export function createApiFetch(options: ApiFetchOptions): ApiFetch {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const { apiKey, nativeOrigin } = options;
  // The base as a decoding proxy reads it, once; without one, no path
  // could be shown to be under it, and the key would never go.
  const proxiedBase =
    apiKey === undefined ? "" : normalized(apiKey.path)?.replace(/\/$/, "");
  if (proxiedBase === undefined)
    throw new Error(
      "apiBaseUrl's path has a malformed percent-escape, so apiKey could never be sent: fix the path, or leave apiKey unset.",
    );
  return async (input, init) => {
    if (apiKey !== undefined || nativeOrigin !== undefined) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      // A request that names its own credentials keeps them.
      if (
        apiKey !== undefined &&
        !headers.has("Authorization") &&
        receivesKey(input, apiKey, proxiedBase)
      )
        headers.set("Authorization", `Bearer ${apiKey.value}`);
      // Request strips the forbidden Origin header before Capacitor forwards
      // it. Send a native-only marker; the API restores Origin only when no
      // browser Origin is present. This header is deliberately excluded from
      // CORS.
      if (nativeOrigin !== undefined)
        headers.set("X-Balebase-Native-Origin", nativeOrigin);
      init = { ...init, headers };
    }
    const response = await send(input, init);
    options.apiVersion.record(response);
    return response;
  };
}

/**
 * Better Auth's routes, which take a session and never an API key: the
 * API's mount in `packages/api/src/app.ts`.
 */
export const authRoutes = "/api/auth";

/**
 * Whether `input` goes under the key's base, to a route an API key may
 * reach. Servers and proxies read a path differently, so the key goes only
 * when both readings agree: the path as `fetch` sends it (dot segments
 * resolved), which the API decodes once before routing, and the path as a
 * decoding proxy may pass it on (see `normalized`). Neither may leave the
 * base or be one of Better Auth's routes. This keeps the key from obvious
 * mistakes; the API, which refuses keys on routes they may not reach, is
 * the boundary.
 */
function receivesKey(
  input: RequestInfo | URL,
  key: ApiKeyScope,
  proxiedBase: string,
) {
  const url = urlOf(input);
  if (url?.origin !== key.origin) return false;
  // The API decodes the path once before routing, so `/api/%61uth` is
  // Better Auth's too.
  const sent = routeUnder(url.pathname, key.path);
  const routed = sent === undefined ? undefined : decodeOnce(sent);
  const proxied = routeUnder(normalized(url.pathname), proxiedBase);
  return (
    routed !== undefined &&
    proxied !== undefined &&
    !isAuthRoute(routed) &&
    !isAuthRoute(proxied)
  );
}

/** What follows `base` in `path`, or undefined when `path` is not under it. */
function routeUnder(path: string | undefined, base: string) {
  if (path === undefined) return undefined;
  if (path !== base && !path.startsWith(`${base}/`)) return undefined;
  return path.slice(base.length);
}

function isAuthRoute(route: string) {
  return route === authRoutes || route.startsWith(`${authRoutes}/`);
}

/**
 * `path` as a proxy that decodes it may pass it on: percent-escapes
 * decoded, `%2F` and `\` read as slashes, repeated slashes merged, and the
 * dot segments that makes (`..%2F`) resolved. Undefined when it has a
 * malformed escape, which the API decodes around: such a path could be any
 * route, so it gets no key. The typed client never sends one.
 */
function normalized(path: string) {
  const decoded = decodeOnce(path);
  if (decoded === undefined) return undefined;
  const slashes = decoded.replace(/%2f|\\/gi, "/").replace(/\/{2,}/g, "/");
  return new URL(slashes, "https://route.invalid").pathname;
}

function decodeOnce(path: string) {
  try {
    return decodeURI(path);
  } catch {
    return undefined;
  }
}

/**
 * The URL `input` goes to. `fetch` resolves a relative URL against the
 * document's base URL, which a `<base>` element can move off the page's
 * origin; outside a page, it cannot send one at all.
 */
function urlOf(input: RequestInfo | URL) {
  const url = input instanceof Request ? input.url : input;
  try {
    return new URL(url, pageBase());
  } catch {
    return undefined;
  }
}

function pageBase() {
  if (typeof document !== "undefined") return document.baseURI;
  return typeof location === "undefined" ? undefined : location.href;
}
