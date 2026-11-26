# Using the client SDK

Clients reach the API through two workspace packages, each a layer on the one
below:

| Package | Owns |
| --- | --- |
| `@balebase/api-client` | `ApiClient`: one typed method per route, from the contract in `@balebase/validators`, and `ApiError` |
| `@balebase/client-sdk` | `Balebase`: the client runtime without React. It holds the `ApiClient`, the Better Auth client, the API version, device connectivity, offline work, and saved Finance transactions, and adapts the host's platform services into them |

Both export TypeScript source from `src/index.ts`; consumers need a
TypeScript-aware bundler or runtime and the workspace dependencies installed.
An application host builds on the SDK, which re-exports `ApiError` and the
`ApiClient` types it needs. The
[package README](../packages/client-sdk/README.md) lists its options and
public symbols.

## Another browser shell

Supply an API origin without a trailing slash or `/api` suffix. The client
appends each endpoint's complete path. For an already authenticated browser:

```ts
import { ApiError, Balebase } from "@balebase/client-sdk";

export async function currentUser(apiOrigin: string) {
  const balebase = new Balebase({ apiBaseUrl: apiOrigin });
  try {
    const session = await balebase.api.session.me(); // GET /api/me
    return session.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
```

A host that needs only the typed routes can use the lower layer directly,
without the SDK's version tracking or native request marker:

```ts
import { ApiClient } from "@balebase/api-client";

const client = new ApiClient({ baseUrl: "https://api.balebase.com" });
const { user } = await client.session.me();
```

See `src/session.ts`, `src/transport.ts`, and `src/ApiError.ts` in the
`api-client` package for the signatures and error behavior. `ApiError` exposes
`status`, `code`, and the original `response`. Network or CORS failures can
reject before an HTTP response exists and need not be `ApiError` instances. An
endpoint with a `timeoutMs` (offline sync and job output reads) rejects with a
`TimeoutError` `DOMException` when it runs out.

Requests default to `credentials: "include"`; this does not sign the user in.
The browser must already have a valid API session cookie. The API's CORS
middleware accepts the configured `CORS_ORIGIN` exactly, enables credentials,
and exposes `API-Version` and other response headers
(`packages/api/src/app.ts`). Authentication also checks trusted origins
(`packages/api/src/auth/auth.ts`). An arbitrary new shell origin is not
automatically authorized. Check its origin, cookie policy, and sign-in flow
against a local or staging API before treating this example as a working
integration.
The production origin is declared in `packages/api/wrangler.jsonc`; staging
sets it in `scripts/deploy/createStagingConfigs.ts`. These are configured
values, not proof of the settings currently deployed to a live Worker.

## Existing application and native hosts

Inside `packages/app`, use the app's one SDK, `balebase()` from
`src/balebase.ts`, rather than making another: `balebase().api` for routes,
`balebase().auth` for sign-in, sessions, and organizations (and
`useSession` from `shared/useSession.ts` for the session in a component),
`balebase().fetch` for API files outside the routes, `balebase().network` for
connectivity, `balebase().offline` for work done on the device,
`balebase().financeCache` for the transactions it keeps, and
`balebase().apiVersion` for the version the API last reported. It is made
from the host `configureHost` set, which `renderApp` does before the first
render, and is made again if the host changes; until a shell configures one,
as in tests, it is a browser's. In a production browser build it passes
`waitForOfflineShell`, so no offline work is stored before the service worker
that reopens the app is active.

The native shell supplies its host in `packages/app-capacitor/src/host.ts`
and enables `CapacitorHttp` in `capacitor.config.ts`. The host's
`native.origin` becomes the SDK's `nativeOrigin`, which marks every request
with `X-Balebase-Native-Origin`; `packages/api/src/auth/nativeRequest.ts`
reads it. That marker is not authentication and is deliberately excluded from
browser CORS headers. Do not set it for an ordinary browser. The host's
`network`, OS connectivity on a device, becomes the SDK's `network` source.

Outside a browser, default `fetch` does not provide a browser session cookie
jar. The `fetch` option replaces the transport, but the caller must
explicitly implement its environment's authentication and cookie handling.
Standard `fetch` already matches the option's signature; a narrowing wrapper
is not required. Add a wrapper when you need additional behavior.
Neither package alone establishes a signed-in Node/Bun or native session.

## Verification

From the repository root:

```sh
bun run --cwd packages/client-sdk test
bun run --cwd packages/client-sdk check
bun run --cwd packages/api-client test src/transport.test.ts
bun run --cwd packages/api-client check
```

These check both layers with fixtures and TypeScript. They do not demonstrate
live login, browser CORS, cookie persistence, or native device behavior.
Validate those in the intended host, and run the broader
[PR checks](../CONTRIBUTING.md#check-a-change) for a shipped change.
