import { expect, it } from "bun:test";
import { createApiFetch } from "./apiFetch";
import { ApiVersion } from "./apiVersion";

/** Whether a request to `path` on the API's origin carries the key. */
async function sendsKey(base: string, path: string) {
  let authorization: string | null = null;
  const fetch = createApiFetch({
    apiKey: { origin: "https://api.test", path: base, value: "tlk_test_key" },
    apiVersion: new ApiVersion(),
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response();
    },
    nativeOrigin: undefined,
  });
  await fetch(`https://api.test${path}`);
  return authorization !== null;
}

it("sends the key only to API routes, however a proxy reads the path", async () => {
  // [base path, request path, whether the key goes]
  const cases: [string, string, boolean][] = [
    ["", "/api/me", true],
    ["", "/api/objects/a%20b", true],
    // Only the routes under /api/auth are Better Auth's.
    ["", "/api/authors", true],
    ["", "/auth/get-session", true],
    ["", "/api/auth", false],
    ["", "/api/auth/get-session", false],
    // The API decodes the path once before routing.
    ["", "/api/%61uth/get-session", false],
    // A proxy may decode %2F and \, and merge slashes.
    ["", "/api%2Fauth/get-session", false],
    ["", "/api/me/..%2fauth/sign-out", false],
    ["", "/%5Capi/auth/get-session", false],
    ["", "//api//auth/get-session", false],
    // As sent, this is Better Auth's, whatever a proxy makes of it.
    ["", "/api/auth/..%2f..%2fme", false],
    // A malformed escape could be any route.
    ["", "/api/objects/%E0%A4%A", false],
    ["/balebase", "/balebase", true],
    ["/balebase", "/balebase/api/me", true],
    ["/balebase", "/api/me", false],
    ["/balebase", "/balebase-old/api/me", false],
    ["/balebase", "/balebase/api/auth/get-session", false],
    ["/balebase", "/balebase//api/auth/get-session", false],
    // ..%2f climbs out of the base behind a proxy that decodes it.
    ["/balebase", "/balebase/..%2fother/api/me", false],
    ["/balebase", "/balebase/%2e%2e/other/api/me", false],
    ["/v%201", "/v%201/api/me", true],
  ];
  for (const [base, path, expected] of cases) {
    expect([base, path, await sendsKey(base, path)]).toEqual([
      base,
      path,
      expected,
    ]);
  }
});
