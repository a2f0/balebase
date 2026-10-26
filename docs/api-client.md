# Using the typed API client

`@balebase/api-client` is a workspace package whose public entrypoint is
`packages/api-client/src/index.ts`. It exports TypeScript source; consumers
need a TypeScript-aware bundler/runtime and the workspace dependencies installed.
Import `ApiClient`, `ApiError`, and `ApiClientOptions` from the package root.
The methods are handwritten against the route types in `@balebase/validators`.

## Another browser shell

Supply an API origin without a trailing slash or `/api` suffix. The client
appends each endpoint's complete path. For an already authenticated browser:

```ts
import { ApiClient, ApiError } from "@balebase/api-client";

export async function currentUser(apiOrigin: string) {
  const client = new ApiClient({ baseUrl: apiOrigin });
  try {
    const session = await client.session.me(); // GET /api/me
    return session.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
```

See `src/session.ts`, `src/transport.ts`, and `src/ApiError.ts` in the client
package for the signatures and error behavior. `ApiError` exposes `status`,
`code`, `body`, `data`, and the original `response`. Network or CORS failures
can reject before an HTTP response exists and need not be `ApiError` instances.

Requests default to `credentials: "include"`; this does not sign the user in.
The browser must already have a valid API session cookie. The API's CORS
middleware accepts the configured `CORS_ORIGIN` exactly, enables credentials,
and exposes `API-Version` and other response headers
(`packages/api/src/app.ts`). Authentication also checks trusted origins
(`packages/api/src/auth.ts`). An arbitrary new shell origin is not automatically
authorized. Check its origin, cookie policy, and sign-in flow against a local
or staging API before treating this example as a working integration.

## Existing application and native hosts

Inside `packages/app`, use the existing `api` from `src/apiClient.ts` rather
than making another client. Its `fetchApi` wrapper records `API-Version` and
adds the native origin marker when a native host is present. Offline API
requests also receive a 90-second timeout. The shared screens live in
`packages/app`; `packages/app-web` and `packages/app-capacitor` configure their
hosts and entrypoints.

The native shell supplies its host in `packages/app-capacitor/src/host.ts`
and enables `CapacitorHttp` in `capacitor.config.ts`. The shared wrapper and
`packages/api/src/nativeRequest.ts` handle the native origin marker. That marker
is not authentication and is deliberately excluded from browser CORS headers.
Do not add it to an ordinary browser request.

Outside a browser, default `fetch` does not provide a browser session cookie
jar. `ApiClientOptions.fetch` can supply a transport, but the caller must
explicitly implement its environment's authentication and cookie handling.
The package alone does not establish a signed-in Node/Bun or native session.

## Verification

From the repository root:

```sh
bun run --cwd packages/api-client test src/transport.test.ts
bun run --cwd packages/api-client check
```

These check the client implementation with fixtures and TypeScript. They do
not demonstrate live login, browser CORS, cookie persistence, or native device
behavior. Validate those in the intended host, and run the broader
[PR checks](../CONTRIBUTING.md#check-a-change) for a shipped change.
