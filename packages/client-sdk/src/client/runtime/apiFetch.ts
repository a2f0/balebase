import type { ApiVersion } from "./apiVersion";

/** `fetch`'s signature, for the transport the SDK sends API requests with. */
export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ApiFetchOptions {
  apiVersion: ApiVersion;
  fetch: ApiFetch | undefined;
  nativeOrigin: string | undefined;
}

/**
 * `fetch` to the API: marks a native shell's requests with its origin, and
 * records the version each response names. With no transport given it looks
 * the global `fetch` up per call, so a test or shell that replaces it later
 * is still the one used.
 */
export function createApiFetch(options: ApiFetchOptions): ApiFetch {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    if (options.nativeOrigin !== undefined) {
      // Request strips the forbidden Origin header before Capacitor forwards
      // it. Send a native-only marker; the API restores Origin only when no
      // browser Origin is present. This header is deliberately excluded from
      // CORS.
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set("X-Balebase-Native-Origin", options.nativeOrigin);
      init = { ...init, headers };
    }
    const response = await send(input, init);
    options.apiVersion.record(response);
    return response;
  };
}
