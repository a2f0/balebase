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
`scripts/cloudflareEnv.sh` lists every variable the scripts read:

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
