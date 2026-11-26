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
| `waitForOfflineShell` | Resolves once the host can reopen without a connection, such as a web app's active service worker; preparing offline work waits for it |

## The `Balebase` instance

| Member | Holds |
| --- | --- |
| `api` | The `ApiClient` from `@balebase/api-client`: one typed method per route |
| `apiVersion` | The version the latest API response named, with `subscribe` |
| `fetch` | `fetch` for API URLs outside the typed routes, such as files; marks native requests and records the version like every typed call |
| `network` | Whether the device has a network, with `subscribe` |
| `offline` | Forms and issues done on this device and the queue that syncs them; see below |

The package also exports `ApiError` and the `ApiClient`, `FinanceFilters`, and
`IssueFilters` types, so hosts need not import `@balebase/api-client`, and
`errorMessage`, which turns a failure into text to show.

## Offline work

`balebase.offline` keeps a workspace per person and organization in the
`balebase-offline` IndexedDB database: the projects, templates, and people the
last pull read, and the forms, issues, and photos made on the device, with the
jobs that sync them. One workspace is active at a time; `lock` hides it on
sign-out or an account change without deleting unsynced work, and `activate`
refuses an identity confirmed before the last lock (`accessEpoch`).

- `pull` prepares the device for an identity and brings its data up to date;
  `pullForms` brings shared forms up to date with the server's copies.
- `startForm`, `saveAnswer`, `saveProgress`, `completeForm`, and `createIssue`
  record work and queue its writes; `retry` requeues failed ones.
- `sync` drains the active workspace's queue while online, under a Web Lock
  so one tab drains at a time.
- `subscribe` reports each change made in this tab.

The form state machine (`offlineFormState.ts`) and its helpers, such as
`formWrites`, `offlineAnswers`, and `answerBase`, are exported for screens
that show a form's progress. The database name, version, and key shapes, the
localStorage pointer, and the lock names are what devices already hold work
under; changing them strands it.

Offline work needs a browser or WebView: IndexedDB, localStorage, and Web
Locks. Make one `Balebase` per tab. An instance keeps its own lock epoch and
change subscribers, so a second one in the same tab would neither see the
first's locks while storage fails nor tell its subscribers of the first's
changes.

[Using the client SDK](../../docs/client-sdk.md) covers cookies, CORS, native
hosts, and use outside a browser.

## Layout

`src/Balebase.ts` is the composition root and `src/index.ts` the public entry
point. Each facade with its own subsystem has a folder in `src/client/` whose
`index.ts` is the facade, such as `offline/`; runtime state the facade holds
lives in `src/client/runtime/`. Pure domain types and helpers, such as the
offline form state machine and form progress, live in `src/data/`.
