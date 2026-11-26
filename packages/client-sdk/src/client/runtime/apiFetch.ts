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
  return async (input, init) => {
    if (apiKey !== undefined || nativeOrigin !== undefined) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      // A request that names its own credentials keeps them.
      if (
        apiKey !== undefined &&
        !headers.has("Authorization") &&
        receivesKey(input, apiKey)
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

/** Better Auth's routes, which take a session and never an API key. */
const authRoutes = "/api/auth";

/**
 * Whether `input` goes under the key's base, to a route an API key may
 * reach. Paths compare as `fetch` sends them, with dot segments resolved.
 */
function receivesKey(input: RequestInfo | URL, key: ApiKeyScope) {
  const url = urlOf(input);
  if (url?.origin !== key.origin) return false;
  const { pathname } = url;
  if (pathname !== key.path && !pathname.startsWith(`${key.path}/`))
    return false;
  const route = pathname.slice(key.path.length);
  return route !== authRoutes && !route.startsWith(`${authRoutes}/`);
}

/**
 * The URL `input` goes to. `fetch` resolves a relative URL against the
 * page; outside one, it cannot send it at all.
 */
function urlOf(input: RequestInfo | URL) {
  const url = input instanceof Request ? input.url : input;
  try {
    return new URL(
      url,
      typeof location === "undefined" ? undefined : location.href,
    );
  } catch {
    return undefined;
  }
}
