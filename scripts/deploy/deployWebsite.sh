#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/lib/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
load_cloudflare_env

export PUBLIC_APP_URL="${PUBLIC_APP_URL:-https://app.balebase.com}"
# Production is the only indexable tier; never inherit staging's noindex.
export PUBLIC_RELEASE_TIER=production

echo "Building website with app URL $PUBLIC_APP_URL..."
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bun --bun run --cwd "$REPO_ROOT/packages/website" build
  bunx --bun wrangler deploy \
    --config "$REPO_ROOT/packages/website/wrangler.jsonc" \
    --dry-run
  exit 0
fi

echo "Deploying website Worker..."
bun --bun run --cwd "$REPO_ROOT/packages/website" deploy
