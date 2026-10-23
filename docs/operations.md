# Deployment and maintenance

[Local setup](../README.md) · [Product reference](product.md)

## Local secrets

`.secrets` is a gitignored link to `../matrix-secrets/balebase`, managed and
backed up from the matrix repository (a2f0/matrix,
[`docs/secrets.md`](https://github.com/a2f0/matrix/blob/main/docs/secrets.md)).
Each tier folder is self-contained. Production commands, and commands that take
no tier, read `.secrets/prod`; staging commands read `.secrets/staging`. Within
a tier, `shared.env` holds values copied from a cross-project root file and
loads first when present; the tier's own `app.env` loads last and wins. The
local API reads the production tier, then takes only its Checkr credentials
and Plaid Sandbox client ID and secret from the staging tier when one exists.
The `ci/` folder holds GitHub Actions values that the matrix repository
deploys; repository code never reads it.

## Provision Cloudflare resources

Put the Cloudflare credentials in `.secrets/prod/app.env`, then review the
Terraform plan. Both tokens must be scoped to the `balebase.com` zone;
`scripts/lib/cloudflareEnv.sh` lists every variable the scripts read:

```sh
export TF_VAR_cloudflare_api_token=your-account-token
export TF_VAR_cloudflare_account_id=your-account-id
export CLOUDFLARE_EMAIL_API_TOKEN=your-zone-token
export TF_STATE_ACCESS_KEY_ID=r2-state-token-id
export TF_STATE_SECRET_ACCESS_KEY=sha256-of-r2-state-token
bun run terraform:plan
```

The D1 and R2 resources have been provisioned and the D1 ID is recorded in the
API Wrangler configuration. To recreate or change infrastructure, review and
apply Terraform separately:

```sh
bun run terraform:plan
bun run terraform:apply
```

Inbound mail to `upload+<organization-id>@inbox.balebase.com` is handled by
the API Worker. Email Routing is enabled once in the Cloudflare dashboard;
Terraform then creates the `inbox.balebase.com` MX records and routes the
address to the Worker. The Worker stores the full `.eml` and each attachment in
the private R2 bucket, with organization-scoped delivery and attachment
metadata in D1.
Organization members can inspect their active organization's mailbox in the
client at `/inbox`. The production tier also needs
`CLOUDFLARE_EMAIL_API_TOKEN`; it configures subaddressing and verifies the
subdomain's Email Routing setup. The Terraform token needs Email Routing Rules
Write.

## Shared issues migration

The API 0.1.32 release requires `0062_create_issues.sql` and
`0063_record_finance_annotations.sql`. The deployment scripts apply migrations
before deploying the API. Migration 0062 preserves audit issue IDs, attachments,
and history while replacing `audit_issues` with the shared `issues` table.
The previous Worker cannot read or write audit issues after that replacement:
expect audit requests to fail during the migration-to-Worker deployment window.
Schedule this release accordingly and finish the API deployment promptly.
If deployment fails after migration, retry deploying the new API; rolling the
Worker back alone does not restore the old schema. Keep the normal D1 recovery
point available if a full schema-and-Worker rollback is needed.

## Deploy production

The full deployment checks the repository, applies D1 migrations, deploys the
API, app, and website Workers, checks that the production hostnames are safe,
attaches them through Terraform, and verifies the public URLs:

```sh
bun run deploy
```

Terraform shows its domain plan and asks for confirmation. For a reviewed,
non-interactive deployment, use `AUTO_APPROVE=1 bun run deploy`.

Exercise checks, production builds, and Wrangler packaging without changing
remote state:

```sh
DRY_RUN=1 bun run deploy
```

Each deployment lane is also available independently:

```sh
bun run deploy:api      # migrate D1 and deploy the API Worker
bun run deploy:app      # build with the production API URL and deploy
bun run deploy:website  # build with the production app URL and deploy
bun run deploy:domains  # preflight and attach custom domains
bun run deploy:email:verify # verify inbound MX records and Worker route
bun run deploy:verify   # check all production URLs
```

## Deploy staging

Staging uses separate Workers, a D1 database, an R2 bucket, and Terraform state
(in the same R2 state bucket as production). Its public URLs are
`website-staging.balebase.com`, `app-staging.balebase.com`, and
`api-staging.balebase.com`. Inbound uploads use
`upload+<organization-id>@inbox-staging.balebase.com`. The flat hostnames work
with Cloudflare Universal SSL on the `balebase.com` zone.

Put these values in `.secrets/staging/app.env`. Use a new auth secret, sandbox
Plaid credentials, and Stripe test-mode credentials and price:

```sh
TF_VAR_cloudflare_api_token=...
TF_VAR_cloudflare_account_id=...
CLOUDFLARE_EMAIL_API_TOKEN=...
TF_STATE_ACCESS_KEY_ID=...
TF_STATE_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=...
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_TOKEN_ENCRYPTION_KEY=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STAGING_STRIPE_PRO_PRICE_ID=price_...
# Optional: STAGING_STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
# Optional, enables inline Checkout: STAGING_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

Provision the isolated database and bucket before the first Worker deployment.
The first apply leaves custom domains and the inbound mail rule disabled until
their target Workers exist:

```sh
bash terraform/scripts/run.sh staging apply \
  -var=enable_custom_domains=false -var=enable_email_routing=false
DRY_RUN=1 bun run deploy:staging  # check build and Worker packaging
bun run deploy:staging
```

The staging deploy runs checks and tests, applies staging D1 migrations, updates
staging Worker secrets, deploys the three Workers, attaches the staging domains
and inbound mail route through Terraform, and checks the public URLs. Terraform
asks for confirmation before applying the domains. The generated
`wrangler.staging.jsonc` files are ignored; their D1 ID comes from staging
Terraform output. The staging API does not run production's scheduled jobs.
Configure the Stripe test-mode webhook at
`https://api-staging.balebase.com/api/billing/webhook` and put that endpoint's
signing secret in `STRIPE_WEBHOOK_SECRET`.

For later infrastructure changes, use `bun run terraform:staging:plan` and
`bun run terraform:staging:apply`. Cloudflare Email Routing subaddressing must
be enabled once for the zone, as described in the inbound email setup above.

## Click tracking deployments

CT is initialized only by the production browser bundles at these exact origins:

| Environment | Marketing (`website`) | Browser app (`web-app`) |
| --- | --- | --- |
| production | `https://balebase.com` | `https://app.balebase.com` |
| staging | `https://website-staging.balebase.com` | `https://app-staging.balebase.com` |

Both use site `balebase` and CT's default DNT/GPC behavior. The API checks the
environment against its registered Origin. Update the CT registry before
adding a hostname. The SDK is pinned in `app-web` and `website`; the shared
React package and Capacitor bootstrap do not initialize tracking. The browser
app deliberately keeps CT's generic `/` page so click records do not reveal
workspace routes or workflows. Only the marketing tracker uses fixed public
page names. Never pass record IDs, query parameters, user-derived labels, or
dynamic `data-ct-app` values.

Deploy CT's authenticated dashboard and data API before enabling these
integrations. Both require a signed-in CT account provisioned through the CT
CLI; registration is disabled. Check that unauthenticated dashboard visitors
see sign-in and data API requests return 401. CT account setup is
documented in [CT operations](https://github.com/a2f0/ct/blob/main/docs/operations.md).

For a frontend-only production change, run the two independent lanes after
the normal repository checks. These commands do not migrate or deploy the API,
update Worker secrets, or apply Terraform:

```sh
DRY_RUN=1 bun run deploy:app
DRY_RUN=1 bun run deploy:website
# After reviewing both previews:
bun run deploy:app
bun run deploy:website
bun run deploy:verify
```

For frontend-only staging changes, use the isolated lane after the normal
repository checks:

```sh
DRY_RUN=1 bun run deploy:staging:frontends
# After reviewing both previews:
bun run deploy:staging:frontends
```

The lane loads staging credentials with the existing environment helper,
verifies both existing custom-domain/Worker mappings, and regenerates only the
two frontend configs from current JSONC. It refuses unexpected Worker names,
assets paths, or non-frontend configuration, and builds with the staging API,
website, and app URLs. The normal run deploys only the two staging frontend
Workers and checks the staging URLs. It does not migrate or deploy the API,
write Worker secrets, or apply Terraform.

Verify the live bundles and privacy page on both tiers. Ordinary automated
browser tests must send no CT events. The website browser suite checks both
integrations with intercepted requests, so its privacy tests never write
synthetic data to CT. Sign in to the dashboard with a provisioned CT account,
then choose site `balebase` and the desired app and environment; the dashboard
defaults to production. See
[click tracking](product.md#click-tracking) for data and retention details.

## Checkr communications

Balebase sends branded screening invitations and completion emails. They link
to the person's screening under My documents, use the configured application
host for links and the logo, and keep report results out of the email. Migration
`0068_notify_screening_completion.sql` queues future completions without
backfilling old ones. Failed deliveries retry in **Refresh Checkr screenings**
under admin maintenance, or through the production hourly job. This job can
also be run manually in staging, which has no scheduled jobs.
Its result includes email counts for `sent`, `failed`, and `abandoned`, and a
`queueUnavailable` flag for queue access failures. Delivery retries stop after
ten attempts or seven days. Investigate provider failures before arranging
any separate follow-up for abandoned messages; the candidate can still view
their status in My documents. A `skipped` result means Checkr report refreshes
were disabled because no API key was configured; email outcomes are separate.

Configure Checkr's own communications separately in each account:

1. In Checkr's account settings, add the Balebase logo and verify the
   candidate-facing display name. Keep **Tearleads, LLC** as the legal entity.
   The generated `packages/ui/dist/images/web/apple-touch-icon.png` is an
   opaque 180×180 logo (`bun run images`). Checkr's
   [candidate-experience guide](https://checkr.com/resources/articles/order-your-first-background-check-with-checkr)
   describes company-name and logo branding; confirm the available controls
   with Checkr if your dashboard differs.
2. Account administrators can adjust their own completion and assessment
   emails under **Your profile → Notifications**. These settings do not
   control candidate messages. See
   [account notifications](https://help.checkr.com/s/article/360010450474-Set-account-notifications).
3. Keep candidate notices enabled until Checkr confirms which notices our
   self-hosted Reports integration can replace. Specifically ask about the
   `background_check_copy_notice` completion email, requested report copies,
   missing-information requests, disputes, and adverse-action notices. Also
   confirm whether a custom sender domain is supported. Checkr's
   [candidate-notification guide](https://help.checkr.com/s/article/17124987125655-Disable-candidate-notifications)
   directs customers to support for email suppression.

The code does not suppress Checkr email, change its account branding, or alter
the person's request for a report copy. Sending our completion email does not
replace Checkr's report delivery or dispute process.

## Mobile builds and release setup

The Capacitor shell, `packages/app-capacitor`, holds the iOS and Android
projects and the Fastlane release lanes; its
[README](../packages/app-capacitor/README.md) documents every lane and option.
Production is `com.balebase.app` against `api.balebase.com`, and staging is
`com.balebase.staging.app` ("Balebase Staging") against
`api-staging.balebase.com`, selected by `NATIVE_RELEASE_TIER`.
`bun run mobile:sync` always packages local assets, regenerates the brand
images, and synchronizes native dependencies. Run it before an IDE build and
after changing dependencies or app code. There is no hosted `server.url` or
live-reload server in a release bundle.

Run on a simulator, emulator, or device with:

```sh
bun run mobile:run:ios --target <simulator-or-device-id>
bun run mobile:run:android --target <emulator-or-device-id>
```

Store builds go through the root wrappers, which hold the bundle to the tier's
own HTTPS hosts and hand off to Fastlane:

```sh
bun run mobile:upload:android # or mobile:upload:android:staging
bun run mobile:build:ios      # or mobile:build:ios:staging
```

Root `mobile:build:*`, `mobile:upload:*`, and `mobile:run:*` Bun scripts invoke
the same entrypoints.

### Google Play internal testing

The Play Console apps `com.balebase.app` and `com.balebase.staging.app` use
Play App Signing. Each tier has its own upload key. To publish a signed bundle
to the tier's internal testing track, run:

```sh
bun run mobile:upload:android           # or mobile:upload:android:staging
```

Fastlane reads the following from `.secrets/<prod|staging>/`:

- `balebase-upload.keystore`, a PKCS12 upload key with alias `upload`
- `ANDROID_KEYSTORE_STORE_PASS` and `ANDROID_KEYSTORE_KEY_PASS` from `app.env`,
  the store and key passwords; they are the only values a native release reads
  from `app.env`
- `google-play-service-account-admin.json`, the `tearleads-admin` Play
  service account

The upload uses the next Play version code and the `app-capacitor` package
version as the version name, then rolls the release out to every internal
tester. Testers must be on the app's internal testing list in Play Console.
Promote a build to closed, open, or production tracks in Play Console. If an
upload key is lost or leaked, request an upload key reset in Play Console under
App integrity.

### TestFlight

The App Store Connect apps `com.balebase.app` and `com.balebase.staging.app`
take builds from:

```sh
bun run mobile:upload:ios               # or mobile:upload:ios:staging
```

Fastlane reads the following from `.secrets/<prod|staging>/`:

- `shared.env`, with `TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`,
  `APP_STORE_CONNECT_ISSUER_ID`, and the `MATCH_*` settings of the shared
  `match` repository, copied from the account-level secrets
- `AuthKey_<key-id>.p8`, the App Store Connect API key

The build signs with the team's Apple Distribution certificate and the tier's
`match AppStore <app ID>` profile, installed read-only from `match` into a
temporary keychain. If a profile expires or the bundle ID's capabilities
change, renew it with `bun run --cwd packages/app-capacitor ios:profiles`
(`ios:profiles:staging` for staging; add `force:true` to regenerate it).

The upload uses the next TestFlight build number and the `app-capacitor`
package version as the marketing version. It returns once App Store Connect
accepts the build. Processing takes several more minutes, and then testers in
an internal TestFlight group with automatic distribution get it. External
testing and App Store submission happen in App Store Connect.

The App Store draft's icon comes from its selected build. Uploading to
TestFlight alone does not select a build for that draft. After Apple finishes
processing the upload, select its exact marketing version and build number:

```sh
bun run --cwd packages/app-capacitor ios:select-store-build version:0.1.63 build_number:1
# For the staging app, use ios:select-store-build:staging with its uploaded version/build.
```

This updates only a version in Prepare for Submission. It aligns an empty
draft's version with the uploaded build, then selects that build; it refuses
to rename a draft that already has a build. It does not submit for review or
release the app. See Apple's [build selection guide](https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit).
Before selecting a replacement for a blank icon, rebuild and upload through
the tier's upload wrapper, which regenerates and copies the brand artwork into
the Xcode asset catalog. Check the processed build's icon in TestFlight.

Before wider TestFlight or Play distribution:

1. Deploy the native request adapter in the API before using a remote backend.
   The native HTTP transport sends cookies and an origin marker. When no
   browser Origin is present, the API applies its configured web origin. The
   marker is excluded from allowed CORS headers; existing browser origins and
   authentication callback allowlists remain unchanged.
2. Exercise login, MFA, account switching, logout/relaunch, camera and file
   uploads, PDF viewing/downloads, invitations, and keyboard/back navigation on
   real devices. Email verification and password-reset links currently open
   the hosted web app, which has a separate session and may require signing
   in again. Universal/app links are not configured. Native downloads use the
   system save/share sheet; authenticated images load through native HTTP.
3. Complete store metadata, privacy declarations, and device screenshots.
   Validate the existing Stripe billing and Plaid flows for the intended store
   distribution before submission; this shell does not add native purchases or
   native Plaid SDK integration. Audit the candidate with the
   [readiness lanes and skill](readiness.md) and record the result in its PR.
4. When a store approves the production app, set `listed: true` on its entry
   in `storeListings` (`packages/website/src/site.ts`) and deploy the website,
   so the home page's badge links to the listing.

No automatic mobile deployment is configured.
See [Capacitor's environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
for SDK installation details.

## Retain and purge data

Organization owners can soft-delete an organization from its general settings.
The organization and its workspace data become inaccessible immediately and
retain a `deletedAt` timestamp and the initiating user's ID in D1. Root admins
can initiate the same lifecycle from the admin organization list. Preview or
permanently purge organizations that have been deleted for at least 30 days
with:

```sh
bun run organizations:purge --dry-run
bun run organizations:purge
```

The command targets Cloudflare's remote D1 database and R2 bucket by default.
Pass `--local` to exercise it against local Wrangler storage. R2 objects are
removed before the corresponding D1 organization is deleted, including uploads,
raw inbound messages, and email attachments. D1 foreign-key cascades then remove
the organization's remaining rows.

Inbox messages can be moved to Trash and restored by organization members.
Deleted messages retain their deletion time and initiating user in D1, while
their raw message and attachments remain in R2. Preview or permanently purge
messages that have been in Trash for at least 30 days with:

```sh
bun run emails:purge --dry-run
bun run emails:purge
```

The command targets Cloudflare's remote D1 database and R2 bucket by default.
Pass `--local` to use local Wrangler storage. It removes the raw message and
attachment objects before deleting the D1 email; the attachment rows are then
removed through their foreign-key cascade.

Move legacy R2 keys beneath their owning organization prefix after deploying
the organization-scoped schema:

```sh
bun run organizations:objects:reorganize --dry-run
bun run organizations:objects:reorganize
```

The move downloads each legacy object, uploads it beneath
`organizations/<organization-id>/`, verifies that the bytes match, updates its
D1 key, and only then deletes the legacy object.

Production URLs are `api.balebase.com`, `app.balebase.com`, and
`balebase.com`. See [`terraform/README.md`](../terraform/README.md) for state and
domain details.
