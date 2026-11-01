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

## Error diagnostics

Sentry projects live in the `tearleads` organization, under the `tearleads`
team. Each platform and environment has its own project:

| Target | Staging | Production |
| --- | --- | --- |
| Web | `balebase-web-staging` | `balebase-web-production` |
| API | `balebase-api-staging` | `balebase-api-production` |
| Android WebView | `balebase-android-staging` | `balebase-android-production` |
| iOS WebView | `balebase-ios-staging` | `balebase-ios-production` |

The website and ordinary local/debug builds do not report. Mobile coverage is
JavaScript errors in the WebView; native crash collection is not enabled.

Keep `SENTRY_ORG=tearleads` and `SENTRY_AUTH_TOKEN` in each tier's ignored
`shared.env`. The token needs release and source-map upload access and must
never have a `VITE_` prefix. The release builder removes it from the frontend
build environment. Keep these public values in staging's `app.env`, using
`PRODUCTION` instead of `STAGING` in production:

```sh
SENTRY_STAGING_PROJECT=balebase-web-staging
SENTRY_STAGING_DSN=https://PUBLIC_KEY@oORG.ingest.us.sentry.io/PROJECT_ID
SENTRY_API_STAGING_PROJECT=balebase-api-staging
SENTRY_API_STAGING_DSN=https://PUBLIC_KEY@oORG.ingest.us.sentry.io/PROJECT_ID
SENTRY_ANDROID_STAGING_PROJECT=balebase-android-staging
SENTRY_ANDROID_STAGING_DSN=https://PUBLIC_KEY@oORG.ingest.us.sentry.io/PROJECT_ID
SENTRY_IOS_STAGING_PROJECT=balebase-ios-staging
SENTRY_IOS_STAGING_DSN=https://PUBLIC_KEY@oORG.ingest.us.sentry.io/PROJECT_ID
```

Copy real DSNs from Sentry's project Client Keys page. A missing DSN disables
reporting for that target; an invalid DSN or mismatched project stops a release.
Enable **Prevent Storing of IP Addresses**, default data scrubbing, and data
scrubbing in every project. Disable JavaScript source fetching: uploaded maps
supply code context without fetching application URLs.

The normal production, staging, and staging-frontend deploy commands build and
upload maps before publishing. API deploys build once, upload the resulting
`index.js` map, then publish that same module with Wrangler's `--no-bundle`.
Reports name it `app:///index.js`, matching Sentry's uploaded artifact.
Cloudflare's separate source-map upload remains disabled. React and global
browser failures use an exact generated asset allowlist. The API reports Hono
unhandled request errors, inbound email failures, failed scheduled runs, and
maintenance job failures; errors caught and handled inside individual workflows
are not automatically collected.

Google Play and TestFlight release lanes call `build:release android` or
`build:release ios` before Capacitor sync. Existing installations need a new
release to report. The iOS privacy manifest and readiness expectations
declare crash and diagnostic data for app functionality, without identity
linkage or tracking. Keep App Store privacy answers and Google Play Data
safety disclosures aligned before the next store submission. Release names
are `balebase-<target>@<git SHA>`; the dist is `staging` or `production`.
Configured uploads require a clean Git checkout and valid credentials.
Failed uploads stop deployment or packaging. Source maps are removed from
web and mobile assets even when uploading fails. `DRY_RUN=1` builds and
verifies configuration without uploading maps or publishing Workers. The
package release commands expect the tier's environment to be loaded, as the
deploy wrappers and Fastlane lanes already do.

The private Sentry clients install no automatic integrations. They disable
Sentry's collection categories, tracing, replay, sessions, logs, and client
reports, then reconstruct errors at both the event and transport boundaries.
Only a generic error type/message, approved bundle filename and position,
release, environment, platform, and error source are sent. Raw messages, URLs,
request/response data, account identifiers, form values, console text, and
breadcrumbs are excluded. Reports deduplicate by sanitized location and are
limited to five per minute and twenty per page load (twenty per Worker isolate
hour for the API). Network requests omit credentials and referrers where the
platform supports it. Sentry still receives connection metadata; project IP
scrubbing prevents storing the sender's IP on events.

After deployment, reproduce a known test failure in staging and confirm its
project, environment, release, and resolved source location in Sentry before
releasing to production. Use `bun run test:sentry` for release selection and
asset cleanup tests; `bun run test` also exercises event sanitization and an
actual compiled Worker. The app browser suite exercises React and global errors
with all Sentry traffic intercepted locally.

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

## Background jobs and retained output

Migration `0073_unify_job_runs.sql` moves existing finance runs into `job_runs`
without changing IDs, statuses, checkpoints, leases, retry budgets, or counts.
It preserves pending queue messages, which still contain only the run ID.
Imported runs have an explicit import log; historical start times, attempt totals,
and earlier logs cannot be reconstructed. Processing attempts count claims after
migration: each bank page is an attempt, and retries add further attempts.
The existing `FINANCE_SYNC_QUEUE` binding and per-tier queue names now carry both
maintenance and finance jobs. No additional queue or Terraform resource is needed.

This migration replaces `finance_sync_jobs`; the previous Worker cannot use the
new schema. Deploy during a maintenance window: pause delivery on that tier's
existing queue, let active consumers finish (allow 20 minutes for existing
leases), apply the migration and deploy the new API, then resume queue delivery
and deploy the app. The normal API deploy applies migrations before publishing.
Finance/admin job requests can fail during the migration-to-Worker window. If
publishing fails, keep consumers paused and finish deploying the new API; rolling
back only the Worker does not restore the old table. Preserve the normal D1
recovery point if a schema rollback is needed.

Inspect runs, saved output, and paginated logs in `/root/jobs`. Only platform
admins can read this global history. `job_runs` stores lifecycle state and
allowlisted output; `job_logs` stores lifecycle messages and safe structured
context atomically with state changes. Provider cursors remain internal handler
state. Failed maintenance can have partial effects. If its execution disappears,
a 20-minute lease expires and the next five-minute scheduler marks it failed with
`INTERRUPTED`; it is not automatically replayed. Review its effects before starting
a new run. Finance pages retain their existing retry and checkpoint behavior.

Production's hourly trigger enqueues one run of each maintenance job. Scheduled
IDs deduplicate repeated cron events, and active jobs are shared with manual
requests. Newly scheduled deleted-file cleanup waits for audit-retention work to
finish, including failure, even when queue messages arrive out of order. An
already-active manual cleanup is reused and can overlap that retention run;
existing per-object claims and grace periods still apply. Every five minutes, both
tiers recover pending deliveries and expired finance leases and remove up to 500
terminal runs completed more than 30 days ago, cascading their logs. Active runs
are never expired by history retention. Domain activity history is separate.

After deployment, start a small maintenance job, close and reopen the page, and
verify its queued/running/completed history and named output. Check a manual bank
sync in the same history, confirm duplicate requests share an active run, and
verify a non-admin session cannot access run history or details. Manual
requests also appear in `maintenance_requests`, which job history retention does
not remove; the Jobs page lists them under **Manual requests**.

## Finance background sync

For stopped imports or failed bank reauthorization, use the
[finance troubleshooting runbook](finance-troubleshooting.md). It includes
read-only connection/job queries, the credential-safe Plaid institution-health
probe, and guidance for separating provider outages from Item or browser errors.

Before deploying this change, review and apply each tier's Terraform plan to
create its queue: `balebase-api-finance-sync` in production and
`balebase-api-staging-finance-sync` in staging. The Cloudflare token needs Queues
Edit permission. Terraform owns the queues; Wrangler owns their producer and
consumer bindings and Cron Triggers. Apply `0072_finance_sync_jobs.sql` before
deploying the API, then deploy the app. The normal API deployment applies D1
migrations. A merge alone does not provision resources or deploy.

Both API Workers run the finance scheduler every five minutes (`*/5 * * * *`).
Staging uses only its own D1 database, queue, and Plaid Sandbox credentials; it
still excludes production's hourly maintenance schedule. Production keeps that
hourly schedule in addition to finance scheduling. The staging config generator
preserves this separation. Cron changes can take up to 15 minutes to propagate.
See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Manual requests first commit a job to D1, then await a Queue send before returning
202. If delivery fails or the request disappears between those operations, the
scheduler republishes the pending job. Queue messages contain only a job ID.
Consumers claim a 20-minute lease (longer than the 15-minute queue invocation
limit), import one page of up to 100 transactions, and save the continuation.
Duplicate deliveries cannot run the same job simultaneously. Each page's writes
can be replayed without replacing annotations or categories. The connection's
Plaid cursor advances only when the entire import finishes; a pagination mutation
restarts from the original cursor, up to twice. See
[Cloudflare's background-work guidance](https://developers.cloudflare.com/workers/runtime-apis/context/)
and [queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Temporary errors use exponential backoff (one, two, four, then eight minutes,
rounded up to a scheduler pass), with five attempts per page. Expired leases are
recovered by the scheduler. Failed jobs stay in D1 instead of depending on queue
message retention or a dead-letter queue. Inspect `job_runs` for saved
status, attempts, timestamps, and provider error codes; look for
`job_dispatch_failed`, `job_delivery_failed`, or
`finance_sync_attempt_failed` in Workers Logs. A job may remain queued longer
when the provider or queue is unavailable. Users can retry a failed job with
**Sync now**. Do not delete job rows or advance cursors to force completion.

Disconnecting a bank cancels waiting syncs, including backoff and expired leases.
Only a consumer with a live lease temporarily blocks disconnection. Retrying a
disconnect also finishes local cleanup when Plaid has already removed the Item.

Older installed clients may still use the synchronous `/sync` endpoint. It
starts the same durable job and waits briefly for completed counts; if the job
continues, it returns a message explaining that background sync is still active.
New clients use `/sync-jobs` and monitor the connection's saved status.

Wrangler's local API emulates the queue. Apply local migrations, start the API,
and exercise a scheduled pass with
`curl 'http://localhost:8787/__scheduled?cron=*/5%20*%20*%20*%20*'`.
After deployment, enable daily sync on a Sandbox connection, start a manual sync,
close the page, then reopen it and verify the completed status. Confirm only one
job per opted-in connection and UTC day and verify failures can be retried.

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

`DEPLOY_TIER=staging` selects staging for `deploy:verify` and
`deploy:email:verify`; `bun run deploy:staging:verify` is the shortcut.

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
and inbound mail route through Terraform, and checks the public URLs. Recheck
them later with `bun run deploy:staging:verify`; it runs the production checks
except the Cloudflare edge-error CORS rule, which only production has. Terraform
asks for confirmation before applying the domains. The generated
`wrangler.staging.jsonc` files are ignored; their D1 ID comes from staging
Terraform output. The staging API does not run production's scheduled jobs.
Configure the Stripe test-mode webhook at
`https://api-staging.balebase.com/api/billing/webhook` and put that endpoint's
signing secret in `STRIPE_WEBHOOK_SECRET`.

For later infrastructure changes, use `bun run terraform:staging:plan` and
`bun run terraform:staging:apply`. Cloudflare Email Routing subaddressing must
be enabled once for the zone, as described in the inbound email setup above.

## Search indexing

Only production is indexable. The website and app builds take their tier from
the deploy scripts: `deploy:website` builds the website with
`PUBLIC_RELEASE_TIER=production` and the staging lanes with `staging`, and the
app's `build:release <environment>` sets `VITE_RELEASE_TIER` to match. Other
builds, including `bun run build`, are production.

- Production pages have canonical links, Open Graph and Twitter tags, and the
  home page's JSON-LD. The website publishes `robots.txt` with its sitemap and
  `sitemap.xml`; the app publishes `robots.txt` and names its root canonical.
  Website pages are served at a trailing slash (`/privacy/`), and links to
  them, including `legalLinks` in `packages/ui/src/brand.ts`, use that form so
  they do not redirect.
- The JSON-LD names Tearleads, LLC as the provider with the Organization that
  tearleads.com publishes, under its `@id`
  (`https://tearleads.com/#organization`), name, URL, and logo. Keep those
  in step with that site, so search engines see one company, not two.
- The production Terraform stack turns on the zone's Always Use HTTPS, so
  `http://` on every `balebase.com` host answers 301 to `https://`. Cloudflare
  sends that redirect before any Worker runs, so it carries no `X-Robots-Tag`;
  the HTTPS response it points to does.
- `www.balebase.com` answers 301 to the apex with the path and query kept. It
  is a single redirect rule managed outside Terraform; see
  [www redirect](../terraform/README.md#www-redirect-outside-terraform).
- The website's 404 page is its only noindexed production page. The Worker
  serves it with status 404 for every missing path, but answers its own URL,
  `/404`, with a 200, so it carries `<meta name="robots" content="noindex">`
  and no canonical link, `og:url`, or sitemap entry.
- Production app signing links (`/sign/<token>`) open a contract without an
  account, so the app's `_headers` adds `X-Robots-Tag: noindex, nofollow` to
  every `/sign/*` response.
- Staging builds add `<meta name="robots" content="noindex, nofollow">` to each
  page and an `X-Robots-Tag: noindex, nofollow` rule for every path to
  `_headers`, and omit canonical links and the sitemap. `robots.txt` still
  allows crawling, because a crawler that may not fetch a page never reads its
  noindex.
- The API, app, and website Workers, and the staging configs generated from
  them, set `workers_dev` and `preview_urls` to false. Each answers only on
  its custom domain, not on duplicate `workers.dev` or version preview hosts.

The rules live in `packages/website/src/search.ts` and
`packages/app-web/vite.config.ts`. The zone's Cloudflare-managed
`robots.txt` is a comment-only content-signals notice. It appears only where
a Worker has no `robots.txt` of its own, such as the API; the website and
app files replace it. After a deploy, confirm that production sends noindex
only on signing links and the 404 page, and that staging sends it everywhere:

```sh
curl -sI https://balebase.com/ | grep -i x-robots-tag      # no output
curl -s https://balebase.com/ | grep -c 'name="robots"'    # 0
curl -s https://balebase.com/missing/ | grep -o '<meta name="robots"[^>]*>'
curl -sI https://website-staging.balebase.com/ | grep -i x-robots-tag
curl -s https://balebase.com/robots.txt | grep Sitemap
curl -sI https://app.balebase.com/sign/x | grep -i x-robots-tag  # noindex
curl -sI http://balebase.com/ | grep -i -E '^(HTTP|location)'  # 301 to https
```

For a fuller audit, or before changing these rules, use the
[seo-optimization skill](../skills/seo-optimization/SKILL.md); its probe
script checks every host's metadata, headers, sitemap, and links.

## Click tracking deployments

CT is initialized only by the production browser bundles at these exact origins:

| Environment | Marketing (`website`) | Browser app (`web-app`) |
| --- | --- | --- |
| production | `https://balebase.com` | `https://app.balebase.com` |
| staging | `https://website-staging.balebase.com` | `https://app-staging.balebase.com` |

Both use site `balebase` and CT's default DNT/GPC behavior. The API checks the
environment against its registered Origin. Update the CT registry before
adding a hostname. The SDK is pinned in `packages/diagnostics`, whose
`clickTracking` module the web shell and website call with these origins; the
shared React package and Capacitor bootstrap do not initialize tracking. The
browser app deliberately keeps CT's generic `/` page so click records do not
reveal workspace routes or workflows. Only the marketing tracker uses fixed
public page names. Never pass record IDs, query parameters, user-derived
labels, or dynamic `data-ct-app` values.

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
browser tests must send no CT events. The website and web shell browser suites
check the shared tracker and both bundles with intercepted requests, so their
privacy tests never write synthetic data to CT. Sign in to the dashboard with a
provisioned CT account, then choose site `balebase` and the desired app and
environment; the dashboard defaults to production. See
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
projects and the Fastlane release lanes. Its
[README](../packages/app-capacitor/README.md#releases) is the reference for
every lane and option, the [secrets files](../packages/app-capacitor/README.md#secrets),
and how [build numbers](../packages/app-capacitor/README.md#build-numbers) are
chosen. Production is `com.balebase.app` against `api.balebase.com`, and
staging is `com.balebase.staging.app` ("Balebase Staging") against
`api-staging.balebase.com`; `nativeReleaseTargets.json` defines both, and
`NATIVE_RELEASE_TIER` selects one.

`bun run mobile:sync` packages local assets, regenerates the brand images, and
synchronizes native dependencies. Run it before an IDE build and after
changing dependencies or app code. There is no hosted `server.url` or
live-reload server in a release bundle. Run on a simulator, emulator, or
device with:

```sh
bun run mobile:run:ios --target <simulator-or-device-id>
bun run mobile:run:android --target <emulator-or-device-id>
```

Store builds run from the repository root. `mobile:build:*` builds a signed
artifact without uploading it; `mobile:upload:*` builds and uploads, using the
store's next build number unless you choose one, and prints the number it
used. Add `:staging` for the staging app:

```sh
bun run mobile:upload:android # or mobile:upload:android:staging
bun run mobile:build:ios      # or mobile:build:ios:staging
```

### Google Play internal testing

The Play Console apps `com.balebase.app` and `com.balebase.staging.app` use
Play App Signing, and each tier has its own upload key in its secrets folder.
To publish a signed bundle to the tier's internal testing track, run:

```sh
bun run mobile:upload:android           # or mobile:upload:android:staging
```

The release rolls out to every internal tester; testers must be on the app's
internal testing list in Play Console. Promote a build to closed, open, or
production tracks in Play Console. If an upload key is lost or leaked,
request an upload key reset in Play Console under App integrity.

### TestFlight

The App Store Connect apps `com.balebase.app` and `com.balebase.staging.app`
take builds from:

```sh
bun run mobile:upload:ios               # or mobile:upload:ios:staging
```

The build signs with the team's Apple Distribution certificate and the tier's
`match AppStore <app ID>` profile. If a profile expires or the bundle ID's
capabilities change, renew it with
`bun run --cwd packages/app-capacitor ios:profiles` (`ios:profiles:staging`
for staging; add `force:true` to regenerate it).

The upload returns once App Store Connect accepts the build. Processing takes
several more minutes, and then testers in an internal TestFlight group with
automatic distribution get it. External testing and App Store submission
happen in App Store Connect.

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
Before selecting a replacement for a blank icon, rebuild and upload with the
tier's `mobile:upload:ios` script, which regenerates and copies the brand
artwork into the Xcode asset catalog. Check the processed build's icon in
TestFlight.

### Saved passwords

Native sign-ins offer to save the password; the
[shell README](../packages/app-capacitor/README.md#saved-passwords) explains how.
On iOS, this works only if the domain confirms the app. Each App ID
(`com.balebase.app` and `com.balebase.staging.app`) needs the Associated Domains
capability, and its `match AppStore` profile must be regenerated after that
capability changes (`ios:profiles force:true`). The tier's app frontend must
also serve `/.well-known/apple-app-site-association` as `application/json`.
Deploy the frontend that adds or changes that file before relying on iOS builds
to save passwords. Devices fetch it through Apple's CDN, which can take a day
to pick up a change.

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
   in `storeListings` (`packages/website/src/site.ts`), add the platform to
   `operatingSystem` in `homeStructuredData` (`packages/website/src/search.ts`),
   and deploy the website, so the home page's badge links to the listing.

No automatic mobile deployment is configured.
See [Capacitor's environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
for SDK installation details.

## Offline synchronization

Apply migration `0070_offline_operations.sql` before deploying the API or clients
with offline support. It adds operation and image receipts and extends image
activity to standalone issues. Receipts and their domain writes commit in the
same D1 transaction. Receipts survive source deletion so an old device cannot
recreate deleted work; organization purges remove them through foreign keys.

The web build emits `offline-worker.js`, which precaches the public app shell
and bundled assets. It does not cache authenticated API responses. Navigation
uses the active worker's cached HTML even while online, keeping HTML and assets
on the same version. The web shell checks for updates on startup, focus, page
restoration, reconnection, and return to a visible tab, plus hourly while visible.
Checks are throttled to once a minute. A waiting worker shows **Update available**;
save changes and choose **Update**, then **Update and reload**. Close other app
tabs and windows first: the worker refuses an explicit update while another
app window is open. Only the tab that requested the update reloads, once its new
worker takes control. Updates never unregister workers or clear offline records.
The recovery screen keeps the update notice available if an app screen crashes.
If activation is delayed, the notice explains that the tab will still reload
when the requested worker takes control. Updates activated elsewhere require
confirmation in this tab before it reloads.
With no explicit update, a waiting worker activates after existing tabs close.
Native builds use their bundled shell and the same IndexedDB queue.

Clients cached before this update flow was added must close all app tabs once
to activate a newer worker and receive the update UI. New page code cannot run
inside an older cached shell. The Chromium, Firefox, and WebKit update tests run
with `bun run --cwd packages/app-web test:browser`; install their engines with
`bun run --cwd packages/app-web browsers:install` first.

Cloudflare serves nested app routes through the SPA fallback. Its
default HTML handling redirects `/index.html` to `/`; the offline worker returns
that cached HTML as a fresh response so navigation does not inherit its redirect
history. If a worker built before `@balebase/app-web` 0.1.65 reports a
redirected-response navigation error after deploying a newer web build, use
**Application → Service Workers → Update** in Chrome DevTools,
then close all app tabs and reopen the app so the waiting worker can activate.

Do not clear browser storage as a sync troubleshooting step: pending work and
photos live there. Inspect the device's sync status, restore its original
account/organization access, and retry with the app open. Permanently rejected
work remains local for inspection; retries do not overwrite server records.

## Retain and purge data

Organization owners can soft-delete an organization from its general settings.
The organization and its workspace data become inaccessible immediately and
retain a `deletedAt` timestamp and the initiating user's ID in D1. Root admins
can initiate the same lifecycle from the admin organization list.

The **Purge deleted organizations** job (`purgeDeletedOrganizations`) permanently
deletes up to 25 organizations per run once their deletion is at least 30 days
old. Untouched organizations are processed oldest first; previous attempts rotate
behind them so failures do not block later organizations. It runs with hourly
maintenance at :17 UTC in production and can be started from
**Root Admin → Jobs → Run now** in either tier. Staging
maintenance is manual. The run's saved output reports `purged`, `skipped` (no
longer eligible), and `failed`. A partial failure marks the run failed while
preserving its counts. Worker logs record purged and failed organization IDs.
The purge queues the organization's uploads, raw messages and attachments,
contract documents, templates, employee forms, and screening consents for file
cleanup.

Each organization's eligibility check, deletion, foreign-key cascades,
file-cleanup tombstones, and purge record commit in one D1 batch. A restore
committed first prevents the purge; a purged organization cannot be restored.
User accounts are retained. The purge record (`organization.purged`, like
`user.purged` for accounts) appears under **Root Admin → Jobs → Purge
history** with who deleted the organization and how, but not its name.
The **Purge deleted files** job removes the queued R2 objects in later batches,
after its 15-minute upload grace period, and retries storage failures. In staging,
run that job manually after the grace period to finish file deletion.
File cleanup processes 25 objects per run, so a large backlog can take days to
drain; the grace period is a minimum wait, not a deletion deadline. Additional
manual cleanup runs can drain eligible files sooner.

Root admins can restore discarded global audit forms from **Global Audits →
Discarded forms**. The **Purge discarded global forms** job
(`purgeDiscardedAuditForms`) permanently deletes up to 100 per run once their
discard is at least 30 days old, with their versions and activity; its saved
output reports `purged`. It runs with hourly maintenance in production and from
**Root Admin → Jobs → Run now** in either tier. Each run is one D1 batch
that rechecks eligibility, so a restore committed first keeps the form. Audits
started from a purged form keep their snapshot, and each project that had the
form turned on records its removal by the job.

Inbox messages can be moved to Trash and restored by organization members.
Deleted messages retain their deletion time and initiating user in D1, while
their raw message and attachments remain in R2. The **Purge trashed email** job
(`purgeTrashedEmails`) permanently deletes up to 100 messages per run that have
been in Trash for at least 30 days. It is not scheduled: start it from
**Root Admin → Jobs → Run now**, which records who requested it. Each run
records every purge in the email's history and every link it removes on the
linked record, deletes the D1 rows (attachments and links cascade), and queues
the raw message and attachments for the **Purge deleted files** job, which
deletes them from R2 only after the purge commits and retries failures. A
message restored before the run is kept. Its saved output reports `purged`.

Production URLs are `api.balebase.com`, `app.balebase.com`, and
`balebase.com`. See [`terraform/README.md`](../terraform/README.md) for state and
domain details.
