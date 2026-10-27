# Repository guidance

Start with [README.md](README.md) for setup and
[CONTRIBUTING.md](CONTRIBUTING.md) for layout, validation, and pull request
rules. Operational procedures are in [docs/operations.md](docs/operations.md).

Balebase is the product; Tearleads, LLC is the company that provides it.
Product copy uses `productName`, while copyright notices, the legal pages, and
any other mention of the legal party use `legalEntityName` (both in
`packages/ui/src/brand.ts`). There is no "Balebase, LLC".

Resolve the GitHub repository with `gh repo view --json nameWithOwner`. Work on
a feature branch created with
`agent-tool branch create <type>/<topic> --base main --remote origin`, use
signed Conventional Commits without co-author trailers, and preserve unrelated
edits. Do not force-push or add attribution footers.

Validate with `bun run check` and `bun run test`; CI also runs the client
browser tests and `bun run build`. The pre-push hook checks installed hooks,
destination branch names, and commit trust before running `check` and `test`.
`bun run verify` additionally runs all browser
suites, builds, and mobile sync.

Capture noisy finite commands with the pinned capture harness, for example
`bun run agent:run --label tests -- bun run test` or
`bun run agent:run --label checks -- bun run check`. It preserves the exit
status and full stdout/stderr in a private log, returns a compact receipt on
success, and shows a bounded excerpt (4 KiB and 40 lines by default) on
failure. Inspect warnings, timings, and artifacts with
`bun run agent:logs <log-path>` or targeted searches before accepting a check.
Keep review verdicts, structured audit results, and infrastructure previews
visible. Do not wrap interactive tools or persistent servers, and do not
silence warnings or reduce test coverage to save output.

Ship with the installed `ship-pr` skill. Title, required CI, and version policy
are in `agent-tool.json`: changes to `packages/api`, `packages/app`,
`packages/app-web`, or `packages/app-capacitor` ship with
`agent-tool versions prepare <base-oid>`. After a merge returns the checkout to
`main`, run `bun run hooks:install`. Merging does not deploy; deploy only when
asked, following docs/operations.md.

Keep package scripts as the normal entrypoints. Group repository-owned scripts
by purpose as documented in CONTRIBUTING.md; shared Git, GitHub, hooks, and
validation reporting belong in agent-tool. Update callers, relative paths,
test fixtures, and Turbo inputs when moving a script.

The skills in `.claude/skills` and `.agents/skills` come from the pinned
`@a2f0/agent-tool`; do not edit them. After changing the pin, run
`bun run agents:sync` and commit the lockfile, skills, and
`.agent-tool-skills.json` together.
