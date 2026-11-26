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
| `financeCache` | The transactions this device keeps for Finance; see below |
| `network` | Whether the device has a network, with `subscribe` |
| `offline` | Forms and issues done on this device and the queue that syncs them; see below |

The package also exports `ApiError` and the `ApiClient`, `FinanceFilters`, and
`IssueFilters` types, so hosts need not import `@balebase/api-client`;
`errorMessage`, which turns a failure into text to show; and `randomId`, which
works outside secure contexts where `crypto.randomUUID` does not.

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
Locks. Instances for one API in a tab share its locks and change subscribers,
as they share the device's storage.

## Saved transactions

`balebase.financeCache` keeps each person's copy of an organization's
transactions, in the `balebase-finance` IndexedDB database (`indexedDbStore`)
or, without it, in memory (`memoryStore`). `pull` brings a copy up to date a
page at a time from the change feed, writing each page with its cursor, so an
interrupted pull resumes; tabs share a pull through a Web Lock. `catchUp`
brings a saved copy up to date after a change made away from the overview,
and does nothing without one.

Clearing a copy, after a refusal (`refused` tells one from an unreachable
server; `clearScope`, `clearedOnRefusal`), on signing out (`clearUser`), or
on leaving an organization (`clearFormerOrganizations`), advances an epoch,
so pulls still running keep nothing and raise `SignedOut`. Tabs announce
clearings on a `BroadcastChannel`; `onCleared` and `onClearedElsewhere`
report them. The database name, key shapes, and channel message are what
devices and other releases' tabs already use; changing them strands saved
copies.

A category's per-year counts and totals, which a saved copy keeps current as
transactions move between categories (`categoryYearCounts`) and which screens
sum for a year or all years (`periodTotals`), are exported with it.

[Using the client SDK](../../docs/client-sdk.md) covers cookies, CORS, native
hosts, and use outside a browser.

## Layout

`src/Balebase.ts` is the composition root and `src/index.ts` the public entry
point. Each facade with its own subsystem has a folder in `src/client/` whose
`index.ts` is the facade, such as `offline/` and `finance/`; runtime state the
facade holds lives in `src/client/runtime/`. Pure domain types and helpers,
such as the offline form state machine, form progress, and the transaction
cache's contracts, live in `src/data/`.
