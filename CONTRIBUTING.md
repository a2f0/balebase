# Contributing

Start with the [local setup](README.md#start-locally). Run commands from the
repository root unless a command specifies `--cwd`.

`.mise.toml` pins Bun to the CI version. With mise installed, run
`mise install` and activate mise in your shell. For one command, use
`mise exec -- bun run check:fast`.

## Find the code

| Change | Start here |
| --- | --- |
| API routes, authorization, persistence | `packages/api/src` |
| Request and response schemas for every route | `packages/validators/src` |
| Typed client for those routes | `packages/api-client/src` |
| Database schema | `packages/api/migrations` |
| Application screens | `packages/app/src` |
| Web shell and its Worker | `packages/app-web` |
| Native shell, mobile projects, and Fastlane lanes | `packages/app-capacitor`, `scripts/*Release.sh`, `scripts/run*.sh`, `scripts/lib/nativeRelease.sh` |
| Shared components, icons, styles | `packages/ui/src` |
| Logo and generated images | `assets/brand`, `images` in `agent-tool.json` |
| Public website | `packages/website/src` |
| Deployment and maintenance commands | `scripts`, `terraform` |
| Agent review and merge policy | `agent-tool.json`, `AGENTS.md` |

`packages/app` holds every screen and never imports Capacitor. A shell renders
it with `renderApp` from `@balebase/app/client`, passing the host services in
`src/host.ts`; the native shell supplies its WebView origin, hosted app URL, and
share-sheet saver there.

In the app, a screen such as `Finance.tsx` owns loading and mutations.
`FinanceAccounts.tsx` renders connections and account selection;
`FinanceTransactionHistory.tsx` owns transaction rows and annotation forms.
`financeFormat.ts` formats amounts. Follow those concrete responsibilities
when a screen needs to be split.

Every API call goes through `api`, the `ApiClient` in `src/apiClient.ts`. The
contract in `@balebase/validators` defines each route once, as zod schemas
for its query, body, and response. The API sends each JSON response with
`respond(context, route, body)`, which types the body by the contract. The
client builds its requests from the same route and throws an `ApiError` with
the API's message, code, and response. Under `bun test`, `respond` checks each
response against its schema and fails the test on a mismatch.
`src/contract.test.ts` checks that the API serves exactly the contract's
routes. To add a route, define it in the area's validators file, send its
response with `respond`, and add a method to the area's client.

`assets/brand/logo.svg` is the pixel B logo, drawn only with whole-unit
`<rect>` elements; the app shells and website import this one copy. The `images`
section of `agent-tool.json` declares every image generated from it, and the
pinned `agent-tool images build` renders them, with `pixelSnap` scaling the logo
by whole numbers. Website and client dev and build write the `favicons` target
to their `public/`. `bun run images` writes the `native` target to
`packages/ui/dist/images` (iOS and Android icons and splash screens in
Capacitor's project layout, and the 1024×1024 Plaid icon at
`plaid/icon-1024.png`) and the favicons to its `web/`. The lime and ink fills
match `--color-lime` and `--color-ink` in `packages/ui/src/styles/tokens.css`.
The touch and App Store icons are opaque because iOS blackens transparent
home-screen pixels and the App Store rejects transparency. The 60% Android
adaptive foreground stays inside the 66dp that launchers may leave unmasked,
and the Plaid icon's margin keeps the B whole under a circular crop.
Generated images are ignored; keep binary files out of commits.

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

`check:fast` runs Biome, Markdownlint, file-name checks, and all TypeScript
checks. It needs only the installed JavaScript toolchain. It leaves dependency
reachability, shell lint, and Terraform checks to `check`.

Before opening a PR, run the same commands as CI:

```sh
bun run check
bun run test
bun run --cwd packages/app test:browser
bun run --cwd packages/app-capacitor test:browser
bun run --cwd packages/website test:browser
bun run build
```

The full check needs ShellCheck, Terraform, TFLint, and the Ruby bundle.
Browser tests need Chrome or Chromium; set `CHROME_PATH` to its executable when
needed. Git's pre-commit hook fixes staged formatting; pre-push runs `check`
and `test`.

## Compact command output

Use the pinned `@a2f0/agent-tool` capture harness for noisy, finite development
commands:

```sh
bun run agent:run --label tests -- bun run test
bun run agent:run --label checks -- bun run check
bun run agent:logs /private/path/from-the-receipt.log
```

The harness preserves the command's exit status and full stdout/stderr in a
private log. Success returns a compact receipt; failures include a bounded
excerpt (4 KiB and 40 lines by default). Inspect warnings, timings, and artifacts
with `agent:logs` or targeted searches before accepting a check. Keep review
verdicts, structured audit results, and infrastructure previews visible. Do not
wrap interactive tools or persistent servers, and do not silence warnings or
reduce test coverage to save output.

## Keep changes readable

- Keep related behavior together. Extract a module when it has a clear job;
  avoid generic helpers and re-export layers for a single caller.
- Biome limits functions to 75 nonblank lines and cognitive complexity to 20
  (15 in client TSX). Tests are exempt so fixtures can stay beside assertions.
- API and client source files have an 800 nonblank-line limit. Existing larger
  files have explicit budgets in `biome.jsonc`. Lower or remove those overrides
  when splitting a file; split new responsibilities out instead of raising the
  budget. Blank lines are free: use them to separate ideas.
- Keep exports used and dependencies reachable; both Knip modes run in
  `check`. Explain necessary lint suppressions at the affected line.
- Test observable behavior and failure paths. Use the existing tests for
  mechanical moves; add coverage when behavior changes or a gap matters.
- Write comments for constraints and surprising choices. Put setup in the
  README, product details in [product.md](docs/product.md), and operational
  procedures in [operations.md](docs/operations.md).

## Editor setup

VS Code recommends the repository's Biome, Astro, Markdownlint, and EditorConfig
extensions. Shared settings format JavaScript, TypeScript, JSON, and CSS with
Biome on save, organize imports, and use the workspace TypeScript version.
Generated output is excluded from search. Other editors can use `.editorconfig`
and the same `biome.jsonc`; `bun run format` applies source and Markdown fixes.

## Submit a pull request

Use a feature branch and a Conventional Commit subject of at most 50 characters,
such as `refactor(client): split finance views`. Commits must be signed and
must not include co-author trailers. Run `bun run hooks:install` after hook
changes land.

For agent-assisted shipping, invoke the `ship-pr` skill. The skills in
`.claude/skills` and `.agents/skills` are installed from the pinned
`@a2f0/agent-tool` package; do not edit them. `agent-tool.json` holds the title
policy, the required CI check, and the versioned packages: a change to
`packages/api`, `packages/app`, `packages/app-web`, or `packages/app-capacitor`
ships with a patch bump from
`agent-tool versions prepare`. Pushes run the normal hooks, with your usual
environment and credentials, so review script and dependency changes before
pushing them. After a merge, run `bun run hooks:install` once the checkout is
back on `main`.

After changing the `@a2f0/agent-tool` pin, run `bun run agents:sync` and commit
the lockfile, skills, and `.agent-tool-skills.json` together. CI runs
`bun run agents:check`, so drifted skills fail the required check.

Use [the dependency upgrade workflow](docs/dependency-upgrades.md) when changing
tool or package versions. Keep README focused on purpose, setup, and essential
safe usage, with a short maintenance link. Reusable upgrade procedures and active
constraints, override rationale, and removal conditions belong in that guide.
Put each upgrade's version inventory, migrations, audit/test/preview results,
and skipped groups in its PR, not README or an accumulating documentation
journal. Attribute historical findings to their PR and recheck them before
claiming current status; update or remove guidance as constraints change.
