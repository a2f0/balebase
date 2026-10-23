#!/usr/bin/env bash

get_repo_root() {
  git rev-parse --show-toplevel
}

source_env_file() {
  local env_file="$1"
  local status

  if [[ ! -f "$env_file" ]]; then
    echo "ERROR: $env_file is missing." >&2
    echo "Create it with the variables listed in docs/operations.md." >&2
    return 1
  fi

  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  status=$?
  set +a
  return "$status"
}

# .secrets links to this project's folder in the matrix-secrets repository.
# Each tier folder is self-contained: shared.env, when present, holds values
# copied from the cross-project root file, and app.env holds this project's
# values for the tier, so app.env wins. Pass a root to read a tree other than
# the current Git checkout. Call it as a plain command: a `||` or `if` around
# it disables errexit while the files are sourced, so a malformed line would
# no longer stop the caller.
load_tier_env() {
  local tier="$1"
  local repo_root="${2:-}"
  local tier_dir

  if [[ "$tier" != "prod" && "$tier" != "staging" ]]; then
    echo "ERROR: Unknown secrets tier: $tier" >&2
    return 1
  fi
  if [[ -z "$repo_root" ]]; then
    repo_root="$(get_repo_root)" || return 1
  fi

  tier_dir="$repo_root/.secrets/$tier"
  if [[ -f "$tier_dir/shared.env" ]]; then
    source_env_file "$tier_dir/shared.env"
  fi
  source_env_file "$tier_dir/app.env"
}

load_cloudflare_env() {
  load_tier_env prod
  validate_cloudflare_env

  export CLOUDFLARE_API_TOKEN="$TF_VAR_cloudflare_api_token"
  export CLOUDFLARE_ACCOUNT_ID="$TF_VAR_cloudflare_account_id"
}

load_cloudflare_email_env() {
  load_tier_env prod

  if [[ -z "${CLOUDFLARE_EMAIL_API_TOKEN:-}" ]]; then
    echo "ERROR: Missing CLOUDFLARE_EMAIL_API_TOKEN." >&2
    return 1
  fi

  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_EMAIL_API_TOKEN"
}

validate_cloudflare_env() {
  local missing=()

  [[ -z "${TF_VAR_cloudflare_api_token:-}" ]] &&
    missing+=("TF_VAR_cloudflare_api_token")
  [[ -z "${TF_VAR_cloudflare_account_id:-}" ]] &&
    missing+=("TF_VAR_cloudflare_account_id")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required Cloudflare variables:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi
}

validate_auth_env() {
  if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
    echo "ERROR: Missing BETTER_AUTH_SECRET." >&2
    return 1
  fi
}

validate_plaid_env() {
  local missing=()

  [[ -z "${PLAID_CLIENT_ID:-}" ]] && missing+=("PLAID_CLIENT_ID")
  [[ -z "${PLAID_SECRET:-}" ]] && missing+=("PLAID_SECRET")
  [[ -z "${PLAID_TOKEN_ENCRYPTION_KEY:-}" ]] &&
    missing+=("PLAID_TOKEN_ENCRYPTION_KEY")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required Plaid variables:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi
}

validate_stripe_env() {
  local required_mode="${1:-any}"
  local missing=()

  [[ -z "${STRIPE_SECRET_KEY:-}" ]] && missing+=("STRIPE_SECRET_KEY")
  [[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]] &&
    missing+=("STRIPE_WEBHOOK_SECRET")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required Stripe variables:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi

  if [[ "$required_mode" == "live" ]] &&
    [[ "$STRIPE_SECRET_KEY" != sk_live_* ]] &&
    [[ "$STRIPE_SECRET_KEY" != rk_live_* ]]; then
    echo "ERROR: STRIPE_SECRET_KEY must be a live-mode key for production." >&2
    return 1
  fi

  if [[ "$STRIPE_WEBHOOK_SECRET" != whsec_* ]]; then
    echo "ERROR: STRIPE_WEBHOOK_SECRET must be a Stripe signing secret." >&2
    return 1
  fi
}
