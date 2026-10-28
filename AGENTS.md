# Repository guidance

Read [README.md](README.md) for setup, [CONTRIBUTING.md](CONTRIBUTING.md) for
layout, validation, and pull requests, and
[docs/operations.md](docs/operations.md) for deploys and maintenance.

Balebase is the product; Tearleads, LLC is the company that provides it.
Product copy uses `productName`. Copyright notices, the legal pages, and any
other mention of the legal party use `legalEntityName`. Both are in
`packages/ui/src/brand.ts`. There is no "Balebase, LLC".

Work on a branch from
`agent-tool branch create <type>/<topic> --base main --remote origin`,
preserve unrelated edits, and do not force-push. Ship with the installed
`ship-pr` skill. Commit, title, CI, and version policy live in
`agent-tool.json`; the Git hooks and `ship-pr` apply it. Merging does not
deploy; deploy only when asked.

Validate with `bun run check` and `bun run test`; `bun run verify` runs what CI
runs. These are run groups that record each step, so run them directly and
find their evidence with `agent-tool runs list --head <commit>`.

Run other finite, noisy commands, such as installs, builds, single suites, and
Git commands that run hooks, through
`bun run agent:run --label <name> -- <command> [args...]`, for example
`bun run agent:run --label api-tests -- bun run --cwd packages/api test`. It
keeps the full log and prints a receipt, with an excerpt on failure; read more
with `bun run agent:logs <log-path>`, raising `--tail-lines` or `--max-bytes`
as needed. A zero exit does not rule out warnings,
so inspect them. Run reviews, version preparation, audits, infrastructure
previews, interactive tools, and servers directly. Never narrow a suite or
silence warnings to reduce output.

The skills in `.claude/skills` and `.agents/skills` come from the pinned
`@a2f0/agent-tool`; do not edit them. After changing the pin, run
`bun run agents:sync` and commit the lockfile, skills, and
`.agent-tool-skills.json` together.
