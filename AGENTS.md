# Repository guidance

Start with [README.md](README.md) for setup and
[CONTRIBUTING.md](CONTRIBUTING.md) for layout, validation, and pull request
rules. Operational procedures are in [docs/operations.md](docs/operations.md).

Balebase is the product; Tearleads, LLC is the company that provides it.
Product copy uses `productName`, while copyright notices, the legal pages, and
any other mention of the legal party use `legalEntityName` (both in
`packages/ui/src/brand.ts`). There is no "Balebase, LLC".

Resolve the GitHub repository with `gh repo view --json nameWithOwner`. Work on
a feature branch created with `git switch --no-track -c <type>/<topic>`, use
signed Conventional Commits without co-author trailers, and preserve unrelated
edits. Do not force-push or add attribution footers.

Validate with `bun run check` and `bun run test`; CI also runs the client
browser tests and `bun run build`. The pre-push hook runs the commit-trust
check, `check`, and `test`. Capture noisy finite commands with
`bun run agent:run --label <check> -- <command>`.

Ship with the installed `ship-pr` skill. Title, required CI, and version policy
are in `agent-tool.json`: changes to `packages/api`, `packages/app`,
`packages/app-web`, or `packages/app-capacitor` ship with
`agent-tool versions prepare <base-oid>`. After a merge returns the checkout to
`main`, run `bun run hooks:install`. Merging does not deploy; deploy only when
asked, following docs/operations.md.

The skills in `.claude/skills` and `.agents/skills` come from the pinned
`@a2f0/agent-tool`; do not edit them. After changing the pin, run
`bun run agents:sync` and commit the lockfile, skills, and
`.agent-tool-skills.json` together.
