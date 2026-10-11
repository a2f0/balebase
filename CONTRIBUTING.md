# Contributing

Start with the [local setup](README.md#start-locally). Run commands from the
repository root unless a command specifies `--cwd`.

`.mise.toml` pins Bun and Node to the CI versions. With mise installed, run
`mise install` and activate mise in your shell. For one command, use
`mise exec -- bun run check:fast`.

## Find the code

| Change | Start here |
| --- | --- |
| API routes, authorization, persistence | `packages/api/src` |
| Database schema | `packages/api/migrations` |
| Application screens | `packages/client/src` |
| Shared components, icons, styles | `packages/ui/src` |
| Public website | `packages/website/src` |
| Deployment and maintenance commands | `scripts`, `terraform` |
| Review and PR automation | `packages/agent-tool` |

In the client, a screen such as `Finance.tsx` owns loading and mutations.
`FinanceAccounts.tsx` renders connections and account selection;
`FinanceTransactionHistory.tsx` owns transaction rows and annotation forms.
`financeApi.ts` contains HTTP calls, and `financeFormat.ts` formats amounts.
Follow those concrete responsibilities when a screen needs to be split.

## Check a change

```sh
bun run check:fast
bun run --cwd packages/client test src/Finance.test.tsx
bun run --cwd packages/api test src/app.test.ts
```

`check:fast` runs Biome, Markdownlint, file-name checks, and all TypeScript
checks. It needs only the installed JavaScript toolchain. It leaves dependency
reachability, shell lint, and Terraform checks to `check`.

Before opening a PR, run the same commands as CI:

```sh
bun run check
bun run test
bun run --cwd packages/client test:browser
bun run build
```

The full check needs ShellCheck, Terraform, and TFLint. Browser tests need
Chrome or Chromium; set `CHROME_PATH` to its executable when needed. Git's
pre-commit hook fixes staged formatting; pre-push runs `check` and `test`.

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

The repository-owned shipping skills continue using the trusted-base
`packages/agent-tool` implementation described under pull requests below.
Their credential-bearing orchestration shell must not execute the feature
checkout's `agent:run` script or installed dependency. Continue running validation
through the trusted `runPreflight` action there. Adopting the public skill bundle
would replace this repository's shipping policy and is not part of this setup.

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

For agent-assisted shipping, invoke `ship-pr` from `.codex/skills` or
`.claude/skills`. It commits, bumps changed API/client versions, reviews the
branch before pushing, waits for CI, merges, and reinstalls hooks. Invoke the
skills themselves: they load automation from the trusted base before running
credential-free checks or handling GitHub and reviewer credentials.

Use [the dependency upgrade workflow](docs/dependency-upgrades.md) when changing
tool or package versions.
