# Contributing

Start with the [quick start](README.md#quick-start). Run commands from the
repository root unless a command specifies `--cwd`.

`.mise.toml` pins Bun and Ruby to the CI versions. To run one command without
activating mise, use `mise exec -- bun run check:fast`. In agent shells,
prepend the pinned binary directories under `~/.local/share/mise/installs` to
PATH without running `mise trust`.

Bun manages dependencies and runs all JavaScript tooling, including commitlint,
lint-staged, and Wrangler. Commands use `--bun` to keep that runtime even when
Node.js is installed. `install:dependencies` also runs dependency install
scripts on Bun, including packages whose install command invokes `node`
directly.

## Find the code

Every workspace lives under `packages/`, and infrastructure lives in
`terraform/`.

| Change | Start here |
| --- | --- |
| API routes, authorization, persistence (Hono on Workers, with D1 and R2), in a folder per feature | `packages/api/src` |
| Request and response schemas for every route | `packages/validators/src` |
| Typed client for those routes | `packages/api-client/src` |
| Database schema | `packages/api/migrations` |
| Built-in audit templates and their seed migrations | `packages/api/auditLibrary`, [residential audit library](docs/residential-audit-library.md) |
| Application screens and the host interface each shell fills in | `packages/app/src` |
| Web shell and its Worker | `packages/app-web` |
| Native shell, mobile projects, and Fastlane lanes | [`packages/app-capacitor`](packages/app-capacitor/README.md) (store tiers in `nativeReleaseTargets.json`), `scripts/dev/run*.sh`, `scripts/lib/nativeRelease.sh` |
| Error diagnostics, release maps and tiers, click tracking | `packages/diagnostics`, `scripts/deploy/*Sentry*.ts`, `scripts/lib/sentryRelease.ts` |
| Shared components, icons, styles, and pricing copy | [`packages/ui`](packages/ui/README.md) |
| Logo and generated images | `assets/brand`, `images` in `agent-tool.json`; see [images](packages/ui/README.md#images) |
| Public website (static Astro) | `packages/website/src` |
| Deployment and live verification | `scripts/deploy`, [`terraform`](terraform/README.md) |
| Account and data administration | `scripts/admin` |
| Development launchers and local Scope assessments | `scripts/dev`, `scripts/dev/scope` |
| Repository checks and test harnesses | `scripts/checks`, `scripts/testing` |
| Shared script helpers | `scripts/lib` |
| Agent review and merge policy | `agent-tool.json`, `AGENTS.md` |
| Repository-owned audit and readiness skills | `skills/` (separate from generated `.agents/skills` and `.claude/skills`) |

Package scripts remain the supported entrypoints for CI, hooks, and people.
Group repository scripts by purpose as shown above; keep infrastructure scripts
with their Terraform stacks and Fastlane lanes in the native package. Move every
caller, fixture, and Turbo input together when relocating a script. Reusable
Git, GitHub, hook, and validation-report mechanics belong in the pinned
agent-tool, with repository policy in `agent-tool.json`.

## Use the shared pieces

Reach for these before writing a helper; each line names the file that owns
it.

### Contract (`packages/validators/src`)

- Each route is defined once, as zod schemas for its query, body, and
  response; to add one, define it in the area's validators file, send its
  response with `respond`, and add an endpoint to the area's client.
- `rules.ts` holds zod-free limits and allowed values that the app imports for
  form limits and options; issue priorities and title, description, and image
  limits are in `issueRules.ts`.
- Build body and query schemas from those rules and the fields in `fields.ts`,
  such as `requiredText`, `optionalText`, `calendarDate`, and `PersonSchema`,
  each carrying the message for the rule it enforces.
- Checklist section and item IDs are exact strings: parse them with
  `ChecklistIdSchema`, which never trims them.
- Offline receipts hash the parsed operation, so never change how
  `OfflineOperationSchema` in `offline.ts` parses or normalizes one.
- Each area client in `@balebase/api-client` lists its endpoints typed by the
  contract, so a disagreement fails to compile and zod stays out of the app
  bundle; a refused request throws `ApiError` with the API's message, `code`,
  and `response`.

### API (`packages/api/src`)

- Each feature has a folder, such as `billing/` or `contracts/`, that holds
  its routes, records, helpers, and tests. Modules that three or more
  features use live in `shared/`, and the Worker entry points (`index.ts`,
  `app.ts`, and `types.ts`) stay at the top. Paths below are relative to
  `packages/api/src`.
- Send JSON with `respond(context, route, body)`, and read input with
  `readBody(context, route, message)` and `readQuery` from
  `shared/respond.ts`, which answer 400 with the first broken rule's message;
  only checks that need the database, the date, or other server state stay in
  handlers.
- Under `bun test`, `respond` fails a test whose response breaks its schema,
  and `contract.test.ts` checks that the API serves exactly the contract's
  routes.
- Type routers and contexts with `ApiEnv` from `auth/authMiddleware.ts`.
- Gate owner- and admin-only routes with `requireManager()`, or branch on
  `canManage(context)`, from `organizations/organizationMembers.ts`.
- Mount platform admin routers below `/api/admin`, where `app.ts` applies the
  one `requireAuth` and `requireRole("admin")` guard.
- A mounted router's `onError` replaces the app's, so a router with its own
  must end in `respondToUnexpectedError` from `shared/unexpectedError.ts`, or
  its failures go unreported.
- Read untrusted JSON that no contract schema covers with `isRecord` from
  `shared/jsonInput.ts`.
- Send mail with `sendMail` from `shared/mailSender.ts`, which names the
  sender with `productName`.
- Read plan limits with `organizationPlanLimits(env, organizationId)` from
  `billing/billingEntitlements.ts`; checkout, subscriptions, seats, the
  webhook, retention, and deletion each have a `billing/billing*.ts` module.
- Signing links, signer order, recipient notices, and completion
  (`notifyRecipients`, `firstSigners`, `advanceContract`) live in
  `contracts/contractWorkflow.ts`; `contracts/contractRecords.ts` holds the
  row queries.
- Page lists with `shared/cursorPagination.ts`: query one extra row in a
  stable order (a date plus a unique ID for date lists), let `cursorPage` trim
  it and derive the opaque cursor, and filter and authorize in the query
  before pagination; clients treat cursors as opaque.
- Read uploads and webhook bodies with `readBoundedForm` and
  `readBoundedRequest` from `shared/storage.ts`, which refuse an oversized
  body while it streams, and serve stored files with `storedDownload`, or an
  object already read with `downloadResponse` (`contentDisposition` builds
  its header).
- Write every new upload with `trackedPut`, which queues its key for cleanup
  before the bytes reach R2; the row that references it must hold
  `uploadStillQueued`, and a migration trigger then deletes the queued record.
- Each MCP tool in `mcp/mcp*Tools.ts` names its contract route, and
  `mcp/mcpToolSchema.ts` generates its arguments from the route's path,
  query, and body; a tool adds a title, a description, argument
  `descriptions` (a dotted name such as `recipients.email` reaches inside
  one), `omit` for optional fields it leaves out, and `require` for optional
  fields it must insist on, such as `expectedCurrentVersion`.
- The MCP catalog tests in `auth/apiKeys.test.ts` fail when a tool's route is
  not served or its arguments drift from the route's.
- Issues are created in `issues/issues.ts` (general) and `audits/audits.ts`
  (audit-specific) and replayed by `offline/offlineRecords.ts`; they share the
  `issues` table and its activity triggers, so change a field in both route
  families and the offline operation schema, after reading the
  [issue](docs/product.md#issues-and-transaction-activity) and
  [offline](docs/product.md#offline-work) behavior.

### Database (`packages/api/migrations`)

- D1 counts rows that triggers write in `meta.changes`, and the test D1 does
  too, so check a guarded write's count as zero or non-zero, never `!== 1`.
- Migrations run before the new Worker is published
  ([deploy production](docs/operations.md#deploy-production)), so a migration
  must not drop a trigger, column, or constraint the previous Worker relies
  on; drop it a release later.
- Built-in audit templates are JSON in `packages/api/auditLibrary`, published
  by generated migrations; see
  [validation and updates](docs/residential-audit-library.md#validation-and-updates).

### App (`packages/app/src`)

- `packages/app` holds every screen and never imports Capacitor; a shell
  renders it with `renderApp` from `@balebase/app/client`, passing the host
  services in `host.ts`.
- Call the API through `api`, the `ApiClient` in `apiClient.ts`;
  [API client onboarding](docs/api-client.md) covers other hosts.
- Load with `useLoad`, mutate with `useAction`, and page cursor lists with
  `useCursorPages` and `InfiniteScroll`.
- Show errors with `errorMessage` from `errors.ts` or with `ErrorToast`.
- Add a workspace section with a route in `workspaceRoutes.tsx` and a page and
  sidebar item in `WorkspaceShell.tsx`.
- Build paths with the `workspacePaths.ts` helpers, match a section with
  `isWithin`, read a route's record ID with `recordIdForPath`, and link with
  `AppLink` or `AppButtonLink`.
- Format dates with `labels.ts`, using `formatCalendarDate` for YYYY-MM-DD
  days, and roles with `hasRole` and `formatRoles` from `organizationState.ts`.
- Use `Select` from [`@balebase/ui/react`](packages/ui/README.md#react-primitives)
  for dropdowns, labelled by `Field` or an associated label; compact inline
  controls can use `aria-label` and `className="inputSm"`.
- Every issue form renders `IssueFields` from `IssueForm.tsx`.
- Split a screen as Finance is split: `Finance.tsx` owns loading and
  mutations, `FinanceAccounts.tsx` and `FinanceTransactionHistory.tsx` render
  their parts, and `financeFormat.ts` formats amounts.

### Native and diagnostics

- `packages/app-capacitor/nativeReleaseTargets.json` defines each store tier
  once, and `fastlane/lib/release_build_number.rb` picks both stores' build
  numbers; see [releases](packages/app-capacitor/README.md#releases).
- `@balebase/diagnostics` holds the private Sentry client options
  (`clientOptions.ts`), `releaseTier` (`config.ts`), and the one click-tracking
  module (`clickTracking.ts`).

`bun run mobile:sync` writes the native images into both checked-in Capacitor
projects and restores the Gradle wrapper JAR from the pinned CLI template.
Commit native source and configuration; generated web bundles, images, Android plugin
paths, signing material, and build products remain ignored. After changing Capacitor
dependencies, sync and commit the updated iOS Swift package manifest, which pins
the plugin paths resolved by Bun. CI builds and syncs
the mobile bundle; native SDK builds are described in the operations guide.
The Fastlane lanes need the
[shell's Ruby bundle](packages/app-capacitor/README.md#set-up); `check` runs
RuboCop and `test` runs the lane tests through it.

## Check a change

```sh
bun run check:fast
bun run --cwd packages/app test src/Finance.test.tsx
bun run --cwd packages/api test src/app.test.ts
```

Run API tests through the package command: its working directory loads
`packages/api/bunfig.toml`, whose `testing/responseContractPreload.ts` preload
checks response schemas after each test. API tests use in-memory database
fixtures and test bindings; they do not need `.secrets`, Wrangler login, local
migrations, or a running API. Installing dependencies is still required.

Build API tests from `packages/api/src/testing/`, not local D1 adapters or
binding literals:

- `createTestDatabase` (`database.ts`) applies every migration with foreign
  keys on; only migration tests stop `before` one and call `applyMigrations`.
- `toD1` (`d1.ts`) serves it as D1, with atomic batches and trigger-written
  rows counted in `meta.changes`, and `queryHooks` inject faults that fail the
  test if they never run.
- `testBindings` (`bindings.ts`), `testApp` (`session.ts`), the `seed*`
  builders and `insertBilling` (`seed.ts`), and `requester` and `withFetch`
  (`http.ts`) supply bindings, a signed-in app, rows, JSON requests, and
  outbound HTTP.
- An area's shared builders live in its `*Fixture.ts`, such as
  `billingFixture.ts`, and a module's tests sit beside it, as
  `billing/billingCheckout.test.ts` does.

App test names say where a test runs, and `src/testFileNames.test.ts` fails
when a file's name and environment disagree:

- In `packages/app/src`, `*.test.ts` checks plain logic and `*.test.tsx`
  renders on the server with `renderToStaticMarkup`.
- `*.dom.test.ts` and `*.dom.test.tsx` mount in happy-dom through `installDom`
  from `src/testing/dom.ts`, whose `respond` stubs `fetch` per test; hold
  timers with `holdTimers` from the same file, and signal scrolling with
  `IntersectionObserverFixture` from `src/testing/intersectionObserver.ts`.
- Other tests stub `fetch` with the `respond` that `installFetch` from
  `src/testing/fetch.ts` returns.
- Tests in `packages/app/browser` run in Chrome through
  `bun run --cwd packages/app test:browser`.

`check:fast` runs Biome, Markdownlint, file-name checks, and all TypeScript
checks. It needs only the installed JavaScript toolchain. It leaves dependency
reachability, shell lint, and Terraform checks to `check`.

Before opening a PR, run `bun run verify`. CI runs the same command, so
[`scripts/testing/verify.json`](scripts/testing/verify.json) is the one list
of its steps: `check`, `test`, every browser suite, `build`, and
`mobile:sync`. CI also checks the branch name and that the sync leaves the
committed native projects unchanged. The other plans in `scripts/testing/`
define `check`, `check:fast`, `lint`, and `test`. These run groups run their
steps in order and record source-bound receipts; run them directly and find
the evidence with `agent-tool runs list --head <commit>`.

The full check needs ShellCheck, Terraform, TFLint, and the Ruby bundle.
Browser tests need Chrome or Chromium; set `CHROME_PATH` to its executable when
needed. Puppeteer suites launch it with `chromeLaunchOptions` from
`scripts/testing/chrome.ts`, which gives each browser a disposable profile,
and end it with `closeChrome`, which kills Chrome instead of waiting for a
shutdown that has no time limit. Tests that create a Git fixture pass
`gitFixtureEnv()` from `scripts/testing/gitFixture.ts` to its Git commands:
hooks export `GIT_DIR` and similar variables, and a fixture that inherits them
runs against the real checkout.

The web shell's service worker update suite uses Playwright's Chromium, Firefox,
and WebKit engines. Run `bun run --cwd packages/app-web browsers:install` once
before its browser tests; CI installs them automatically.

The `test:deploy` and `test:env` steps inside `bun run test` exercise local
fixtures and command stubs. They do not deploy, contact a live service, or use
real cloud credentials. Live verification, such as
`bun run deploy:staging:verify`, and Scope assessments are separate opt-in
commands.

## Keep changes readable

- Keep related behavior together. Extract a module when it has a clear job;
  avoid generic helpers and re-export layers for a single caller.
- Biome limits functions to 75 nonblank lines and cognitive complexity to 20
  (15 in `packages/app` TSX). Tests are exempt so fixtures can stay beside
  assertions.
- Source files in `packages/api/src` and `packages/app/src` have an 800
  nonblank-line limit with no per-file exceptions; split a new responsibility
  out instead of adding one. Blank lines are free: use them to separate ideas.
- Keep exports used and dependencies reachable; both Knip modes run in
  `check`. Explain necessary lint suppressions at the affected line.
- Test observable behavior and failure paths. Use the existing tests for
  mechanical moves; add coverage when behavior changes or a gap matters.
- Treat [audit activity](docs/audit-activity.md) as part of a mutation's
  behavior: identify its durable history, actor, transaction boundary, reader
  permissions, and retention. Use the [audit-trails skill](skills/audit-trails/SKILL.md)
  for a requested coverage review and findings report.
- Before a store submission, use the
  [app-store-readiness skill](skills/app-store-readiness/SKILL.md) with the
  [readiness lanes](docs/readiness.md), and record the candidate's findings
  in its PR.
- When changing page metadata, robots rules, sitemaps, or a tier's indexing,
  use the [seo-optimization skill](skills/seo-optimization/SKILL.md) and keep
  [search indexing](docs/operations.md#search-indexing) current.
- Write comments for constraints and surprising choices. Put setup in the
  README, product details in [product.md](docs/product.md), and operational
  procedures in [operations.md](docs/operations.md).

## Scope evaluations

The [Scope guide](docs/scope.md) sets up and runs the local agent-readiness
assessment, and the [assessment summary](docs/agent-readiness.md) records the
last measured result.

## Editor setup

VS Code recommends the repository's Biome, Astro, Markdownlint, and EditorConfig
extensions. Shared settings format JavaScript, TypeScript, JSON, and CSS with
Biome on save, organize imports, and use the workspace TypeScript version.
Generated output is excluded from search. Other editors can use `.editorconfig`
and the same `biome.jsonc`; `bun run format` applies source and Markdown fixes.

## Submit a pull request

Use a feature branch and a Conventional Commit subject, such as
`refactor(app): split finance views`. The Git hooks enforce the branch, commit,
and signature policy in `agent-tool.json` and `commitlint.config.mts`. Run
`bun run hooks:install` after cloning, after hook changes land, and after a
merge returns the checkout to `main`; `bun run hooks:check` reports drift.
After a PR is squash-merged, move a branch stacked on it with
`git rebase --onto origin/main <old-base>`, where `<old-base>` is the commit
the stacked branch was built on.

For agent-assisted shipping, invoke the `ship-pr` skill, which applies the
title, required-check, and version policy in `agent-tool.json`. Pushes run the
normal hooks with your usual environment and credentials, so review script and
dependency changes before pushing them.

The skills in `.claude/skills` and `.agents/skills` are installed from the
pinned `@a2f0/agent-tool` package; do not edit them. After changing the pin,
run `bun run agents:sync` and commit the lockfile, skills, and
`.agent-tool-skills.json` together; `check` runs `bun run agents:check`, so
drifted skills fail CI.

Use [the dependency upgrade workflow](docs/dependency-upgrades.md) when changing
tool or package versions; it says what belongs in that guide and what belongs
in the upgrade's PR.
