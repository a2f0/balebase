# Dependency upgrades

Read the runtime pins from [`.mise.toml`](../.mise.toml), `packageManager` and
`engines` in [`package.json`](../package.json), and CI. Bun owns `bun.lock`.
Preserve exact direct dependency pins and keep React, React DOM, their types,
and the UI peer versions aligned. Run package executables with `bunx --bun` so
their Node shebangs do not select another runtime. CI rejects direct Node, npm,
and npx invocations in repository commands.

Keep reusable procedures and active constraints here. Put each upgrade's dated
version inventory, migrations, audit/test/preview evidence, and skipped groups
in its PR. Update or remove guidance when constraints change; do not append run
journals. Attribute historical findings to their PR and recheck them before
claiming current upstream status or production safety.

Use the `update-dependencies` skill for either harness. It references the
published shared workflow at `@a2f0/agent-tool@0.1.11` while keeping this
repository's trusted-base `packages/agent-tool` shipping implementation.

## Compatibility

- TypeScript stays on 6.0.3 because `@astrojs/check` supports TypeScript 5/6.
  The native TypeScript 7 release removes APIs used by language tooling.
  Explicit Bun types in the automation workspace account for TypeScript 6's
  new default type inclusion. See the [TypeScript 6 release notes][typescript].
- Follow the [Astro major upgrade guide][astro] when changing compiler,
  Markdown, whitespace, or API behavior; verify image handling against the
  [AVIF advisory][astro-advisory] and the selected release.
- [Commitlint 21][commitlint] runs on Bun here. Its header policy requires
  Conventional Commits and a maximum of 50 characters; this repository does not
  parse its diagnostics.
- [Lint-staged 17][lint-staged] runs on Bun here and requires Git 2.32.0.
  Configuration is in package.json, so the optional YAML dependency is not
  needed to load the staged-file rules.
- [Knip 6.40][knip] reports exports used only in their declaring file. Keep
  those declarations private, preserve both full and production analysis,
  and include CSS in project patterns for the font import compiler.

## Security fixes and remaining constraints

Markdownlint CLI 0.23.3 pins smol-toml 1.8.0, which is affected by
[GHSA-r4xh-jqrq-34v2][toml-advisory]. An exact-parent override selects the fixed
1.9.0 parser. Its null-prototype objects expose a Markdownlint 0.41.1
`instanceof Object` incompatibility: nested TOML rule options, disabled rules,
and warning severity are silently lost. A Bun-generated patch recognizes
null-prototype objects; `bun run test:markdownlint` exercises the actual CLI
with TOML, JSON, and the repository JSONC configuration. Remove the override
when the CLI permits the fixed parser; remove the patch when Markdownlint
preserves the same regression cases without it. Confirm removal with a fresh audit.

Wrangler and the API's prerelease Miniflare are retained when real resource
previews or the Workerd integration are unavailable. Their exact Sharp and
Undici pins can retain security advisories; a blanket override would bypass
the owner's supported integration. Revisit those groups when complete previews
and the owning integration checks are available.

[PR #95](https://github.com/a2f0/stealth/pull/95) recorded the following constraints
and exposure analysis. They explain the retained choices, not a fresh audit or
a claim about today's available upstream fixes:

- Braces 3.0.3, owned by Markdownlint's Micromatch dependency, had no published
  fixed release for [GHSA-vfj7-8cjw-p6xm][braces-advisory].
- KaTeX 0.16.47 remained inside Micromark's math extension's supported range;
  the advisory required 0.18.2, outside that range.
- HTTP Cache Semantics 4.3.0 satisfied Astro's range, but its [shared cache
  advisory][cache-advisory] had no maintainer-confirmed patched version. The
  inspected Astro cache immediately expired the affected zero-TTL entries and
  did not pass `max-stale`. Being outside an advisory's published range alone
  did not prove the library flaw fixed.

Recheck advisories, owner ranges, and exposure when upgrading. Remove a constraint
when a supported owner upgrade or a tested, narrowly scoped compatibility patch
resolves it, with a fresh audit and relevant integration checks. Put the resulting
audit and any remaining exposure in that upgrade's PR.

## Infrastructure and deployment

Run complete refreshed saved Terraform plans against the real production and
staging states, with their own variables and resource identities, before
changing Terraform core, providers, or modules. Reject every deletion,
replacement, recreation, incomplete plan, or unknown action. The historical
email-rule retirement described in terraform/README.md includes destruction;
it must not be executed as part of a dependency upgrade.

Wrangler's `deploy --dry-run` bundles code. Independently verify the deployed
account, Worker, domains/routes, D1 and R2 IDs, bindings, and migration effects.
When remote identity or data effects cannot be established, retain Wrangler
and its coupled deployment changes. Do not run an apply or deployment to
establish compatibility. The branch CI only checks, tests, and builds.

## Validation and shipping

Install dependencies and hooks as described in README.md. Run the complete
`check`, `test`, client browser tests, and `build` commands. The Workerd upload
integration requires local sockets; provider validation and TFLint require
the installed provider/plugin runtime. An unavailable platform or service is
a validation gap, even when unrelated checks pass.

Use the repository-owned `ship-pr` skill with `chore: update dependencies`.
It fetches and materializes the trusted base automation, runs its
credential-free preflight, signs commits, bumps changed API/client packages,
independently reviews each changed HEAD, and checks CI and the exact fresh
reviewed head/base before merging. Preserve every gate when resuming a held
upgrade. Keep the upgrade PR's ledger of selected and constrained dependencies,
audits, checks, warnings, previews, review, merge, and deployment results there;
promote only ongoing procedures or active constraints into this guide.

[typescript]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
[astro]: https://docs.astro.build/en/guides/upgrade-to/v7/
[astro-advisory]: https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2
[commitlint]: https://github.com/conventional-changelog/commitlint/releases/tag/v21.0.0
[lint-staged]: https://github.com/lint-staged/lint-staged/releases/tag/v17.0.0
[knip]: https://github.com/webpro-nl/knip/releases/tag/knip%406.40.0

[toml-advisory]: https://github.com/advisories/GHSA-r4xh-jqrq-34v2
[braces-advisory]: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

[cache-advisory]: https://github.com/advisories/GHSA-ch52-4w7c-c8xp
