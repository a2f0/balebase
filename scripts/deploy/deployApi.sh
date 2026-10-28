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
load_cloudflare_env
validate_auth_env
validate_plaid_env
validate_stripe_env live
bun --bun run --cwd "$REPO_ROOT/packages/api" deploy --check

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Dry-running API Worker deployment..."
  bun --bun run --cwd "$REPO_ROOT/packages/api" deploy
  exit 0
fi

echo "Applying production D1 migrations..."
bun --bun run --cwd "$REPO_ROOT/packages/api" db:migrate:remote

echo "Updating API Worker secrets..."
put_api_worker_secrets "$REPO_ROOT/packages/api/wrangler.jsonc"

echo "Deploying API Worker..."
bun --bun run --cwd "$REPO_ROOT/packages/api" deploy
