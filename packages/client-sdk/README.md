# @balebase/client-sdk

The Balebase client runtime without React: the typed API and the client state
that outlives a screen. Hosts adapt their platform services into the SDK
rather than duplicate its setup; `packages/app` builds its screens on it.

## Quick start

```ts
import { Balebase } from "@balebase/client-sdk";

const balebase = new Balebase({ apiBaseUrl: "https://api.balebase.com" });
const { user } = await balebase.api.session.me();
```

With no options, requests go to the page's own origin through the global
`fetch`, and connectivity comes from the browser. Outside a browser there is
no page origin, so set `apiBaseUrl`.

## Options

Every field of `BalebaseOptions` is optional.

| Option | Use |
| --- | --- |
| `apiBaseUrl` | The API origin, without a trailing slash or `/api` |
| `fetch` | The transport; defaults to the global `fetch`, looked up per request |
| `nativeOrigin` | A native shell's WebView origin, sent as `X-Balebase-Native-Origin` |
| `network` | A `NetworkStatusSource`, such as the OS's on a device; defaults to the browser's |

## The `Balebase` instance

| Member | Holds |
| --- | --- |
| `api` | The `ApiClient` from `@balebase/api-client`: one typed method per route |
| `apiVersion` | The version the latest API response named, with `subscribe` |
| `fetch` | `fetch` for API URLs outside the typed routes, such as files; marks native requests and records the version like every typed call |
| `network` | Whether the device has a network, with `subscribe` |

The package also exports `ApiError` and the `ApiClient`, `FinanceFilters`, and
`IssueFilters` types, so hosts need not import `@balebase/api-client`.

[Using the client SDK](../../docs/client-sdk.md) covers cookies, CORS, native
hosts, and use outside a browser.

## Layout

`src/Balebase.ts` is the composition root and `src/index.ts` the public entry
point. Runtime state the facade holds lives in `src/client/runtime/`.
