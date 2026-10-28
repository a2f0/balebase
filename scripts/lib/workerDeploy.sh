#!/usr/bin/env bash

# Steps shared by the production and staging deploy scripts. Load the tier's
# environment with cloudflareEnv.sh before calling them.

put_worker_secret() {
  local config="$1"
  local secret_name="$2"

  printf '%s' "${!secret_name}" | bunx --bun wrangler secret put \
    "$secret_name" --config "$config" >/dev/null
}

# Upload the API Worker's secrets from the loaded environment. Checkr is
# optional, so its values are uploaded only when set.
put_api_worker_secrets() {
  local config="$1"
  local secret_name

  for secret_name in BETTER_AUTH_SECRET PLAID_CLIENT_ID PLAID_SECRET \
    PLAID_TOKEN_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
    put_worker_secret "$config" "$secret_name"
  done
  for secret_name in CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE; do
    if [[ -n "${!secret_name:-}" ]]; then
      put_worker_secret "$config" "$secret_name"
    fi
  done
}

# Build the app and website against the staging hostnames.
build_staging_frontends() {
  local repo_root="$1"

  VITE_API_URL=https://api-staging.balebase.com \
    VITE_WEBSITE_URL=https://website-staging.balebase.com \
    bun --bun run --cwd "$repo_root/packages/app-web" build:release staging
  PUBLIC_APP_URL=https://app-staging.balebase.com PUBLIC_RELEASE_TIER=staging \
    bun --bun run --cwd "$repo_root/packages/website" build
}

# Deploy the staging app and website Workers. DRY_RUN=1 only packages them.
deploy_staging_frontends() {
  local repo_root="$1"
  local package
  local config

  for package in app-web website; do
    config="$repo_root/packages/$package/wrangler.staging.jsonc"
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      bunx --bun --no-install wrangler deploy --config "$config" --dry-run
    else
      bunx --bun --no-install wrangler deploy --config "$config"
    fi
  done
}
