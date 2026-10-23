import { afterEach, expect, test } from "bun:test";
import { fetchJsonWithTimeout, fetchWithTimeout } from "./fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("bounds stalled headers even when fetch ignores abort", async () => {
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: originalFetch.preconnect,
  });
  await expect(fetchWithTimeout("https://example.com", {}, 10)).rejects.toThrow(
    "timed out",
  );
});

test("bounds a stalled JSON body after headers arrive", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
    { preconnect: originalFetch.preconnect },
  );
  await expect(fetchJsonWithTimeout("https://example.com", 10)).rejects.toThrow(
    "timed out",
  );
});
