#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/lib/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id
load_tier_env staging "$REPO_ROOT"
validate_cloudflare_env
export CLOUDFLARE_API_TOKEN="${TF_VAR_cloudflare_api_token:-}"
export CLOUDFLARE_ACCOUNT_ID="${TF_VAR_cloudflare_account_id:-}"

cd "$REPO_ROOT"
# Fail before building or uploading unless both existing domains match their
# intended Workers. Regenerate only the two frontend configs from current JSONC.
bun scripts/deploy/prepareStagingFrontends.ts
VITE_API_URL=https://api-staging.balebase.com \
  VITE_WEBSITE_URL=https://website-staging.balebase.com \
  bun --bun run --cwd packages/app-web build:release staging
PUBLIC_APP_URL=https://app-staging.balebase.com \
  bun --bun run --cwd packages/website build

for package in app-web website; do
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    bunx --bun --no-install wrangler deploy \
      --config "$REPO_ROOT/packages/$package/wrangler.staging.jsonc" --dry-run
  else
    bunx --bun --no-install wrangler deploy \
      --config "$REPO_ROOT/packages/$package/wrangler.staging.jsonc"
  fi
done
if [[ "${DRY_RUN:-0}" != "1" ]]; then bash "$SCRIPT_DIR/verifyStaging.sh"; fi
