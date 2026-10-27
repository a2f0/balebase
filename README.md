# Balebase

Balebase is small business management software for expenses, contracts,
employee forms, documents, equipment, and audits. This repo is available on
the web at <https://balebase.com>. The browser app at
<https://app.balebase.com> and the iOS and Android apps all use the API at
<https://api.balebase.com>. Balebase runs on Cloudflare Workers, D1, and R2.

## Quick start

Install [mise](https://mise.jdx.dev/), or [Bun](https://bun.sh/) 1.4.3
directly; Node.js and npm are not required.

```sh
mise install                 # the Bun and Ruby versions pinned in .mise.toml
bun run install:dependencies
bun run hooks:install
bun run --cwd packages/api db:migrate:local
bun run dev
# API:     http://localhost:8787
# Client:  http://localhost:5173
# Website: http://localhost:4321
```

The local API reads `BETTER_AUTH_SECRET` and optional integration keys from
`.secrets`, a gitignored link to `../matrix-secrets/balebase` that the
[matrix repository](https://github.com/a2f0/matrix/blob/main/docs/secrets.md)
manages and backs up. See [local secrets](docs/operations.md#local-secrets).
The dev launcher stops before starting Wrangler if `.secrets/prod/app.env`
is absent or `BETTER_AUTH_SECRET` is empty. Dependency installation and API
unit tests do not need that file; see the
[focused verification path](CONTRIBUTING.md#check-a-change).

Wrangler persists the local D1 database and R2 bucket under
`packages/api/.wrangler/`. The client defaults to the local API. Override it by
copying `packages/app-web/.env.example` to `packages/app-web/.env`. To build
and run the native apps, see the
[Capacitor shell's local development](packages/app-capacitor/README.md#develop-locally).

## Layout

Every workspace lives under `packages/`, and infrastructure lives in
`terraform/`:

| Path | Contents |
| --- | --- |
| `packages/api` | Hono API on Cloudflare Workers, with D1 and R2 bindings |
| `packages/validators` | The zod request and response contract for every API route |
| `packages/api-client` | The typed client for those routes |
| `packages/app` | The React application: screens, API calls, and the host interface each shell fills in |
| `packages/app-web` | The Vite web shell deployed to Cloudflare |
| [`packages/app-capacitor`](packages/app-capacitor/README.md) | The Capacitor iOS and Android shell, with its native projects and Fastlane release lanes |
| [`packages/ui`](packages/ui/README.md) | The shared design system (tokens, component styles, React primitives, icons, and pricing copy) used by the app and the website |
| `packages/diagnostics` | Sentry error reporting shared by the API and app shells |
| `packages/website` | The static Astro marketing site |
| [`terraform`](terraform/README.md) | D1, R2, and `balebase.com` Worker-domain infrastructure |

Release builds report filtered errors to Sentry, with separate projects for
web, API, Android, and iOS in staging and production. Development builds stay
local. See [error diagnostics](docs/operations.md#error-diagnostics) for setup,
collection limits, and source-map uploads.

The hosted website and browser app use the CT click tracker in production and
staging. Tracking honors Do Not Track and Global Privacy Control browser
settings. See [click tracking](docs/product.md#click-tracking) for collected
fields, administrator access, and opt-outs.

## Common commands

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused checks, editor setup, code
organization, and the pull request workflow.

```sh
bun run check:fast # format, lint source, and type-check (no infrastructure tools)
bun run check     # full lint and type checks, including infrastructure
bun run test      # package tests and script regression tests
bun run build     # production builds
bun run format    # apply source and Markdown fixes
```

The full `check` also needs ShellCheck, Terraform, TFLint, and the Fastlane
Ruby bundle. Provisioning and deploys read their Cloudflare credentials from
`.secrets`, as the deployment guide describes.

## Reference

- [Product behavior and integrations](docs/product.md): authentication,
  organizations, library, inbox, equipment, contracts, audits, finance,
  employee forms, and billing.
- [Deployment and maintenance](docs/operations.md): local secrets, Cloudflare
  provisioning, production and staging deploys, and data retention commands.
- [Native apps](packages/app-capacitor/README.md): local iOS and Android
  builds, the staging app, and the store release lanes.
- [Release readiness](docs/readiness.md): store candidate audits and the
  readiness lanes.
- [Infrastructure](terraform/README.md): Terraform state and domains.
- [Dependency upgrades](docs/dependency-upgrades.md): compatibility constraints
  and the upgrade workflow.
- [Residential audit library](docs/residential-audit-library.md): sources and
  upkeep of the bundled checklist.
