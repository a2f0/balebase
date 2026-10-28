#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/lib/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
# shellcheck source=scripts/lib/workerDeploy.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/workerDeploy.sh"
# Like the Cloudflare credentials, application secrets come only from staging.
unset BETTER_AUTH_SECRET PLAID_CLIENT_ID PLAID_SECRET \
  CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE \
  PLAID_TOKEN_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  STAGING_STRIPE_PRO_PRICE_ID STAGING_STRIPE_PORTAL_CONFIGURATION_ID \
  STAGING_STRIPE_PUBLISHABLE_KEY
load_cloudflare_tier_env staging "$REPO_ROOT"
validate_auth_env
validate_plaid_env
validate_stripe_env any

if [[ "$STRIPE_SECRET_KEY" != sk_test_* && "$STRIPE_SECRET_KEY" != rk_test_* ]]; then
  echo "ERROR: Staging requires a Stripe test-mode secret key." >&2
  exit 1
fi
if [[ "${STAGING_STRIPE_PRO_PRICE_ID:-}" != price_* ]]; then
  echo "ERROR: STAGING_STRIPE_PRO_PRICE_ID must be a Stripe price ID." >&2
  exit 1
fi
if [[ -n "${STAGING_STRIPE_PUBLISHABLE_KEY:-}" &&
  "$STAGING_STRIPE_PUBLISHABLE_KEY" != pk_test_* ]]; then
  echo "ERROR: STAGING_STRIPE_PUBLISHABLE_KEY must be a test-mode key." >&2
  exit 1
fi

STAGING_D1_DATABASE_ID="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw d1_database_id
)"
STAGING_D1_DATABASE_NAME="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw d1_database_name
)"
STAGING_R2_BUCKET_NAME="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw r2_bucket_name
)"
export STAGING_D1_DATABASE_ID STAGING_D1_DATABASE_NAME STAGING_R2_BUCKET_NAME
if [[ ! "$STAGING_D1_DATABASE_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "ERROR: Staging Terraform has no valid D1 database ID." >&2
  exit 1
fi
if [[ -z "$STAGING_D1_DATABASE_NAME" || -z "$STAGING_R2_BUCKET_NAME" ]]; then
  echo "ERROR: Staging Terraform has no D1 database or R2 bucket name." >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "Running repository checks..."
bun --bun run check
bun --bun run test
bun scripts/deploy/createStagingConfigs.ts

bun --bun run --cwd "$REPO_ROOT/packages/api" deploy staging --check
bun --bun run --cwd "$REPO_ROOT/packages/app-web" build:release staging --check

api_config="$REPO_ROOT/packages/api/wrangler.staging.jsonc"
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bun --bun run --cwd "$REPO_ROOT/packages/api" deploy staging
else
  bunx --bun wrangler d1 migrations apply DB --remote --config "$api_config"
  put_api_worker_secrets "$api_config"
  bun --bun run --cwd "$REPO_ROOT/packages/api" deploy staging
fi

build_staging_frontends "$REPO_ROOT"
deploy_staging_frontends "$REPO_ROOT"
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Staging dry run completed."
  exit 0
fi

DEPLOY_TIER=staging bash "$SCRIPT_DIR/checkDomains.sh"
apply_args=(apply -input=true)
if [[ "${AUTO_APPROVE:-0}" == "1" ]]; then
  apply_args=(apply -auto-approve)
fi
bash "$REPO_ROOT/terraform/scripts/run.sh" staging "${apply_args[@]}"
DEPLOY_TIER=staging bash "$SCRIPT_DIR/verifyDeployment.sh"
DEPLOY_TIER=staging bash "$SCRIPT_DIR/verifyInboundEmail.sh"
echo "Staging deployment completed."
