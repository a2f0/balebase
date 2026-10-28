import { afterEach } from "bun:test";

/** Answers one request from the code under test. */
type FetchHandler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Lets a test answer `fetch`: `respond(handler)` replaces it until the test
 * ends. Call once at a test file's top level, where it registers the restore.
 */
export function installFetch() {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  return function respond(handler: FetchHandler) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(
        new URL(input instanceof Request ? input.url : String(input)),
        init,
      )) as typeof fetch;
  };
}
