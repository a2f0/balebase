#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIER="${1:-prod}"
if [[ "$TIER" == "staging" || "$TIER" == "prod" ]]; then
  if [[ $# -gt 0 ]]; then
    shift
  fi
else
  TIER="prod"
fi
STACK_DIR="$REPO_ROOT/terraform/stacks/$TIER"

# shellcheck source=../../scripts/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/cloudflareEnv.sh"

if [[ "$TIER" == "staging" ]]; then
  unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id
  load_tier_env staging "$REPO_ROOT"
  validate_cloudflare_env
else
  load_cloudflare_env
fi

if [[ -z "${TF_STATE_ACCESS_KEY_ID:-}" || -z "${TF_STATE_SECRET_ACCESS_KEY:-}" ]]; then
  echo "ERROR: Missing TF_STATE_ACCESS_KEY_ID or TF_STATE_SECRET_ACCESS_KEY." >&2
  echo "The R2 state backend needs them in .secrets/$TIER/app.env." >&2
  exit 1
fi
# Only Terraform sees the state keys, and an ambient AWS profile or session
# cannot redirect the backend.
unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID="$TF_STATE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$TF_STATE_SECRET_ACCESS_KEY"

if [[ $# -eq 0 ]]; then
  set -- plan
fi

terraform -chdir="$STACK_DIR" init -input=false >/dev/null
exec terraform -chdir="$STACK_DIR" "$@"
