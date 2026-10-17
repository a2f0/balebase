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
| Database schema | `packages/api/migrations` |
| Application screens | `packages/client/src` |
| Shared components, icons, styles | `packages/ui/src` |
| Public website | `packages/website/src` |
| Deployment and maintenance commands | `scripts`, `terraform` |
| Agent review and merge policy | `agent-tool.json`, `AGENTS.md` |

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
`packages/api` or `packages/client` ships with a patch bump from
`agent-tool versions prepare`. Pushes run the normal hooks. After a merge, run
`bun run hooks:install` once the checkout is back on `main`.

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
