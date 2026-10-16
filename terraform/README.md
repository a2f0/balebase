# Cloudflare infrastructure

This stack provisions the Cloudflare resources used by the API and records the
desired Worker custom domains:

- D1 database: `balebase-db`
- R2 bucket: `balebase-objects`
- Email Routing MX records for `inbox.balebase.com` (Email Routing itself is
  enabled once in the dashboard)
- Inbound email: `upload+<organization-id>@inbox.balebase.com` → `balebase-api`
- Website: `balebase.com`
- Client: `app.balebase.com`
- API: `api.balebase.com`, with CORS headers on Cloudflare-generated responses

The separate `stacks/staging` stack provisions `balebase-db-staging`,
`balebase-objects-staging`, staging email routing, and first-level staging
hostnames. See the [staging deployment steps](../docs/operations.md#deploy-staging).

## Secrets

The scripts load these variables from the production tier, `.secrets/prod`
(`shared.env` when present, then `app.env`), without copying them into
Terraform files or state. The staging stack reads `.secrets/staging` the same
way:

```sh
export TF_VAR_cloudflare_api_token="..."
export TF_VAR_cloudflare_account_id="..."
export CLOUDFLARE_EMAIL_API_TOKEN="..."
export TF_STATE_ACCESS_KEY_ID="..."
export TF_STATE_SECRET_ACCESS_KEY="..."
```

`.secrets` is a gitignored link to `../matrix-secrets/balebase`, managed and
backed up from the matrix repository; see
[local secrets](../docs/operations.md#local-secrets). The Terraform token needs
Zone Read, DNS Write, D1 Edit, R2 Edit, Workers Scripts Edit, and Email Routing
Rules Write and Zone Transform Rules Write on the `balebase.com` zone. The
separate Email API token needs Zone Read and Zone Settings Edit on the same
zone so deploys can enable subaddressing and verify the subdomain's Email
Routing DNS records. The `TF_STATE_*` pair is the R2 S3 key of the
`balebase-terraform-state` token, limited to the state bucket: the key ID is the
token ID and the secret is the SHA-256 of the token value. `scripts/run.sh`
hands it to Terraform as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

## State

Each stack keeps its state in the Cloudflare R2 bucket
`balebase-terraform-state` (`prod/terraform.tfstate` and
`staging/terraform.tfstate`) through the S3 backend, with lockfile-based
locking. The bucket was created once by hand before any state existed and is not
managed here. CI validates with `-backend=false` and never reads state.

## Plan and apply

Review the plan before making changes:

```sh
bun run terraform:plan
```

Apply infrastructure only after the plan is understood:

```sh
bun run terraform:apply
```

The production deployment script deploys the three Workers before applying the
custom domains because each target Worker must already exist.

## Domain cutover

The domain deployment runs a read-only preflight that rejects hostnames attached
to another Worker or occupied by A, AAAA, or CNAME records. It then presents an
interactive Terraform apply:

```sh
bun run deploy:domains
```

The canonical hostnames are part of the default Terraform desired state. Set
`enable_custom_domains = false` only when intentionally removing them.

## Moving from tearleads.de

The stacks moved from the `tearleads.de` zone to `balebase.com` in October 2026.
D1 and R2 names cannot change, so production data was copied from `stealth-db`
and `stealth-objects` into the new resources, and the old ones were removed from
state rather than destroyed. Nothing here references `tearleads.de` or
`tearleads.com`.
