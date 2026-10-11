# Tearleads

Tearleads runs on Cloudflare Workers, D1, and R2. Every workspace lives
under `packages/`:

- `packages/agent-tool` — repository automation shared by the agent workflows.
- `packages/api` — Hono API on Cloudflare Workers, with D1 and R2 bindings.
- `packages/client` — React and Vite application.
- `packages/ui` — the shared design system (tokens, component styles, React
  primitives, icons, and pricing copy) used by the client and the website.
- `packages/website` — static Astro marketing site.

Infrastructure lives outside the workspaces in `terraform` (D1, R2, and
`tearleads.de` Worker-domain infrastructure).

## Start locally

Install [Bun](https://bun.sh/) 1.4.2 and Node.js 22.22.1 or newer; CI uses
Node.js 24.21.0. Bun owns the workspace lockfile; Node runs tooling with Node
shebangs, including commitlint and lint-staged. Install Terraform, TFLint, and
ShellCheck for the complete lint suite. Authenticate Wrangler with a Cloudflare
account when you are ready to provision remote resources.

If you use mise, `mise install` installs the Bun and Node versions pinned in
`.mise.toml`, matching CI.

```sh
bun install
bun run hooks:install
bun run --cwd packages/api db:migrate:local
bun run dev
```

Local services use these addresses:

- API: <http://localhost:8787>
- Client: <http://localhost:5173>
- Website: <http://localhost:4321>

Wrangler persists the local D1 database and R2 bucket under
`packages/api/.wrangler/`. The client defaults to the local API. Override it by
copying `packages/client/.env.example` to `packages/client/.env`.

## Working in the repo

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused checks, editor setup, code
organization, and the pull request workflow.

```sh
bun run check:fast # format, lint source, and type-check (no infrastructure tools)
bun run check     # full lint and type checks, including infrastructure
bun run test      # package tests and script regression tests
bun run build     # production builds
bun run format    # apply source and Markdown fixes
```

## Reference

- [Product behavior and integrations](docs/product.md): authentication,
  organizations, library, inbox, equipment, contracts, audits, finance,
  employee forms, and billing.
- [Deployment and maintenance](docs/operations.md): Cloudflare provisioning,
  production and staging deploys, backups, and data retention commands.
- [Infrastructure](terraform/README.md): Terraform state and domains.
- [Dependency upgrades](docs/dependency-upgrades.md): compatibility constraints
  and the upgrade workflow.
- [Residential audit library](docs/residential-audit-library.md): sources and
  upkeep of the bundled checklist.
