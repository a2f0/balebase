# Balebase

Balebase runs on Cloudflare Workers, D1, and R2. Every workspace lives
under `packages/`:

- `packages/api` — Hono API on Cloudflare Workers, with D1 and R2 bindings.
- `packages/app` — the React application: screens, API calls, and the host
  interface each shell fills in.
- `packages/app-web` — the Vite web shell deployed to Cloudflare.
- `packages/app-capacitor` — the Capacitor iOS and Android shell, with its
  native projects and Fastlane release lanes.
- `packages/ui` — the shared design system (tokens, component styles, React
  primitives, icons, and pricing copy) used by the app and the website.
- `packages/website` — static Astro marketing site.

Infrastructure lives outside the workspaces in `terraform` (D1, R2, and
`balebase.com` Worker-domain infrastructure).

## Start locally

Install [Bun](https://bun.sh/) 1.4.3. Bun manages dependencies and runs all
JavaScript tooling, including commitlint, lint-staged, and Wrangler. Commands
use `--bun` to keep that runtime even when Node.js is installed. Install
Terraform, TFLint, and ShellCheck for the complete lint suite. Authenticate
Wrangler with a Cloudflare account when you are ready to provision remote
resources.

If you use mise, `mise install` installs the Bun version pinned in `.mise.toml`,
matching CI. Node.js and npm are not required.

```sh
bun run install:dependencies
bun run hooks:install
bun run --cwd packages/api db:migrate:local
bun run dev
```

`install:dependencies` also runs dependency install scripts on Bun, including
packages whose install command invokes `node` directly.

Local services use these addresses:

- API: <http://localhost:8787>
- Client: <http://localhost:5173>
- Website: <http://localhost:4321>

The local API reads `BETTER_AUTH_SECRET` and optional integration keys from
`.secrets`, a gitignored link to `../matrix-secrets/balebase` that the
[matrix repository](https://github.com/a2f0/matrix/blob/main/docs/secrets.md)
manages and backs up. See [local secrets](docs/operations.md#local-secrets).

Wrangler persists the local D1 database and R2 bucket under
`packages/api/.wrangler/`. The client defaults to the local API. Override it by
copying `packages/app-web/.env.example` to `packages/app-web/.env`.

## Mobile development

The native app is named **Balebase** and uses `com.balebase.app` on both
platforms. Its staging build, **Balebase Staging**
(`com.balebase.staging.app`), installs beside it. Install Xcode 26 or later
for iOS, or Android Studio with Android SDK 37 and JDK 21 for Android, and
the pinned Ruby (`mise install`) for the Fastlane release lanes. The app
supports iOS 18+ and Android 12+; the iOS floor also covers the embedded PDF
viewer's browser APIs.

```sh
bun run mobile:ios      # build, sync both native projects, and open Xcode
bun run mobile:android  # build, sync both native projects, and open Android Studio
bun run mobile:sync     # rebuild web assets, icons, and native dependencies
./scripts/runIos.sh     # build and run on a selected simulator/device
./scripts/runAndroid.sh # build and run on a selected emulator/device
```

Choose a simulator or connected device and run the app from the IDE. These
commands bundle the app locally into `packages/app-capacitor/dist` and default
to `https://api.balebase.com`. Native networking preserves cookie
authentication; deploy the API's mobile-origin support before testing against
a remote environment.

To point a local build at staging, prefix these commands with
`NATIVE_RELEASE_TIER=staging`, or put these values in
`packages/app-capacitor/.env.local`. The debug app keeps its
`com.balebase.app` identifier; the staging store app comes from the release
wrappers.

The `.env.local` values:

```dotenv
VITE_API_URL=https://api-staging.balebase.com
VITE_APP_URL=https://app-staging.balebase.com
```

Both URLs must use HTTPS. Emailed verification and password-reset links open
the hosted app. See
[packages/app-capacitor/README.md](packages/app-capacitor/README.md) for the
store release lanes and
[mobile builds and release setup](docs/operations.md#mobile-builds-and-release-setup)
for the remaining store setup.

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

Agents can capture noisy finite commands with
`bun run agent:run --label tests -- bun run test`. See
[compact output](CONTRIBUTING.md#compact-command-output) for private logs.

## Reference

- [Product behavior and integrations](docs/product.md): authentication,
  organizations, library, inbox, equipment, contracts, audits, finance,
  employee forms, and billing.
- [Deployment and maintenance](docs/operations.md): local secrets, Cloudflare
  provisioning, production and staging deploys, and data retention commands.
- [Infrastructure](terraform/README.md): Terraform state and domains.
- [Dependency upgrades](docs/dependency-upgrades.md): compatibility constraints
  and the upgrade workflow.
- [Residential audit library](docs/residential-audit-library.md): sources and
  upkeep of the bundled checklist.
