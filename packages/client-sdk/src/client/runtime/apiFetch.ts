import type { ApiVersion } from "./apiVersion";

/** `fetch`'s signature, for the transport the SDK sends API requests with. */
export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ApiFetchOptions {
  /** Sent only to `apiOrigin`, so a file or link on another host never sees it. */
  apiKey: { origin: string; value: string } | undefined;
  apiVersion: ApiVersion;
  fetch: ApiFetch | undefined;
  nativeOrigin: string | undefined;
}

/**
 * `fetch` to the API: sends the host's API key to the API's origin, marks a
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
        originOf(input, apiKey.origin) === apiKey.origin
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

/** The origin `input` goes to, resolving a relative URL against `base`. */
function originOf(input: RequestInfo | URL, base: string) {
  const url = input instanceof Request ? input.url : input;
  try {
    return new URL(url, base).origin;
  } catch {
    return undefined;
  }
}
