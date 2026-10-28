# Contributing

Start with the [quick start](README.md#quick-start). Run commands from the
repository root unless a command specifies `--cwd`.

`.mise.toml` pins Bun to the CI version. With mise installed, run
`mise install` and activate mise in your shell. For one command, use
`mise exec -- bun run check:fast`. In agent shells, prepend the pinned binary
directories under `~/.local/share/mise/installs` to PATH without running
`mise trust`.

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
| API routes, authorization, persistence (Hono on Workers, with D1 and R2) | `packages/api/src` |
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

`packages/app` holds every screen and never imports Capacitor. A shell renders
it with `renderApp` from `@balebase/app/client`, passing the host services in
`src/host.ts`; the native shell supplies its WebView origin, hosted app URL, and
share-sheet saver there.

In the app, a screen such as `Finance.tsx` owns loading and mutations.
`FinanceAccounts.tsx` renders connections and account selection;
`FinanceTransactionHistory.tsx` owns transaction rows and annotation forms.
`financeFormat.ts` formats amounts. Follow those concrete responsibilities
when a screen needs to be split.

Load with `useLoad`, mutate with `useAction`, and show errors with
`errorMessage` from `src/errors.ts` or `ErrorToast`. Page cursor lists with
`useCursorPages` and `InfiniteScroll`.

Build paths with the `src/workspacePaths.ts` helpers, read a route's record
ID with `recordIdForPath`, and link with `AppLink`. A new workspace section
needs a route in `src/workspaceRoutes.tsx` and a page and sidebar item in
`WorkspaceShell.tsx`. Format dates with `src/labels.ts`, using
`formatCalendarDate` for YYYY-MM-DD days, and roles with `hasRole` and
`formatRoles` from `src/organizationState.ts`.

Use `Select` from `@balebase/ui/react` for form dropdowns, with `Field` or an
associated label. Compact inline controls can use `aria-label`. `Select`
applies the shared control styles and forwards native select
props, including refs, validation, and change events. Use `className="inputSm"`
for compact controls; native keyboard and mobile pickers remain available.

Every API call goes through `api`, the `ApiClient` in `src/apiClient.ts`. The
contract in `@balebase/validators` defines each route once, as zod schemas
for its query, body, and response. The API sends each JSON response with
`respond(context, route, body)`, which types the body by the contract. Each
area client in `@balebase/api-client` lists the endpoints it calls: a route's
method, path, and body kind, typed by the contract, so a disagreement fails to
compile and zod stays out of the app bundle. A refused request throws an
`ApiError` with the API's message, code, and response. Under `bun test`,
`respond` checks each response against its schema and fails the test on a
mismatch, and `packages/api/src/contract.test.ts` checks that the API serves
exactly the contract's routes. To add a route, define it in the area's
validators file, send its response with `respond`, and add an endpoint and
method to the area's client.

Cursor-paginated API lists use `packages/api/src/cursorPagination.ts`. Query one
extra row in a stable order, then use `cursorPage` to trim the page and derive
its continuation from the last visible row. Date-based lists sort by the date
and a unique ID together and use the shared opaque cursor codec; the decoder
also accepts the earlier JSON and base64 formats. Keep filters and authorization
in each query before pagination, and treat returned cursors as opaque in clients.

API routers share a few primitives. Type routers and contexts with `ApiEnv`
from `authMiddleware.ts`. Gate owner- and admin-only routes with
`requireManager()`, or branch on `canManage(context)`, from
`organizationMembers.ts`. Mount platform admin routers below `/api/admin`,
where `app.ts` applies the one `requireAuth` and `requireRole("admin")` guard.
Read untrusted JSON with `isRecord` and `validText` from `jsonInput.ts`, and
send mail with `sendMail` from `mailSender.ts`, which names the sender with
`productName`.

See [API client onboarding](docs/api-client.md) for a public-import example,
browser credentials and CORS, the shared wrapper, and native host assumptions.

For issue changes, start with the [issue behavior](docs/product.md#issues-and-transaction-activity)
and [offline behavior](docs/product.md#offline-work). Online
creation lives in `packages/api/src/issues.ts` (general issues) and
`audits.ts` (audit-specific routes); offline replay uses
`offlineRecords.ts`. They share the `issues` table and its activity triggers.
Check both route families and the offline operation schema when changing a field.
Issue priorities and image limits live in the zod-free
`packages/validators/src/issueRules.ts`, which the API and the app's online and
offline paths all import; every app issue form renders `IssueFields` from
`IssueForm.tsx`.

The logo and every image generated from it are described in the
[UI package's images section](packages/ui/README.md#images).

`bun run mobile:sync` writes the native images into both checked-in Capacitor
projects and restores the Gradle wrapper JAR from the pinned CLI template.
Commit native source and configuration; generated web bundles, images, Android plugin
paths, signing material, and build products remain ignored. After changing Capacitor
dependencies, sync and commit the updated iOS Swift package manifest, which pins
the plugin paths resolved by Bun. CI builds and syncs
the mobile bundle; native SDK builds are described in the operations guide.
The Fastlane lanes need the pinned Ruby (`mise install`) and
`bundle install` in `packages/app-capacitor`; `check` runs RuboCop and `test`
runs the lane tests through that bundle.

## Check a change

```sh
bun run check:fast
bun run --cwd packages/app test src/Finance.test.tsx
bun run --cwd packages/api test src/app.test.ts
```

Run API tests through the package command: its working directory loads
`packages/api/bunfig.toml`, whose `contractTestSetup.ts` preload checks response
schemas after each test. API tests use in-memory database fixtures and test
bindings; they do not need `.secrets`, Wrangler login, local migrations, or a
running API. Installing dependencies is still required.

Build API tests from `packages/api/src/testing/`, not local D1 adapters or
binding literals. `createTestDatabase` applies every migration with foreign
keys on; only migration tests stop `before` one and call `applyMigrations`.
`toD1` serves it as D1 with atomic batches, and `queryHooks` inject faults
that fail the test if they never run. Use `testBindings`, `testApp`, the
`seed*` builders and `insertBilling` for rows, `requester` for JSON requests,
and `withFetch` for outbound HTTP.

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
needed. Git's pre-commit hook fixes staged formatting; pre-push runs `check`
and `test`.

The web shell's service worker update suite uses Playwright's Chromium, Firefox,
and WebKit engines. Run `bun run --cwd packages/app-web browsers:install` once
before its browser tests; CI installs them automatically.

The `test:deploy` and `test:env` steps inside `bun run test` exercise local
fixtures and command stubs. They do not deploy, contact a live service, or use
real cloud credentials. Live verification, such as
`bun run deploy:staging:verify`, and Scope assessments are separate opt-in
commands. The offline `test:scope` tooling tests run in `verify`, and so in CI,
rather than in every `bun run test`.

## Keep changes readable

- Keep related behavior together. Extract a module when it has a clear job;
  avoid generic helpers and re-export layers for a single caller.
- Biome limits functions to 75 nonblank lines and cognitive complexity to 20
  (15 in `packages/app` TSX). Tests are exempt so fixtures can stay beside
  assertions.
- Source files in `packages/api/src` and `packages/app/src` have an 800
  nonblank-line limit. Existing larger files have explicit budgets in
  `biome.jsonc`. Lower or remove those overrides when splitting a file; split
  new responsibilities out instead of raising the budget. Blank lines are
  free: use them to separate ideas.
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

Use the [Scope guide](docs/scope.md) for the local CLI/container setup,
Claude worker, calibrated Codex judge, and versioned agent-readiness tasks.
The assessment measures repository discoverability against committed snapshots;
its inspection tasks do not establish clean-bootstrap or implementation success.
See the [assessment summary](docs/agent-readiness.md) for the last measured
result.

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

For agent-assisted shipping, invoke the `ship-pr` skill. The skills in
`.claude/skills` and `.agents/skills` are installed from the pinned
`@a2f0/agent-tool` package; do not edit them. `agent-tool.json` also holds the
title policy, the required CI check, and the versioned packages; a change to
one of those packages ships with a patch bump from `agent-tool versions prepare`.
Pushes run the normal hooks with your usual environment and credentials, so
review script and dependency changes before pushing them.

After changing the `@a2f0/agent-tool` pin, run `bun run agents:sync` and commit
the lockfile, skills, and `.agent-tool-skills.json` together. CI runs
`bun run agents:check`, so drifted skills fail the required check.

Use [the dependency upgrade workflow](docs/dependency-upgrades.md) when changing
tool or package versions. That guide holds reusable upgrade procedures, active
constraints, override rationale, and removal conditions; keep README to purpose,
setup, and safe usage. Put each upgrade's version inventory, migrations,
audit, test, and preview results, and skipped groups in its PR, not in an
accumulating documentation journal. Attribute historical findings to their PR
and recheck them before claiming current status.
