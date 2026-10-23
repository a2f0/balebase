#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/lib/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
load_cloudflare_env

export VITE_API_URL="${VITE_API_URL:-https://api.balebase.com}"
export VITE_WEBSITE_URL="${VITE_WEBSITE_URL:-https://balebase.com}"

if [[ "${1:-}" == "--check" ]]; then
  bun --bun run --cwd "$REPO_ROOT/packages/app-web" build:release --check
  exit 0
fi

echo "Building app with API URL $VITE_API_URL and website URL $VITE_WEBSITE_URL..."
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bun --bun run --cwd "$REPO_ROOT/packages/app-web" build:release
  bunx --bun wrangler deploy \
    --config "$REPO_ROOT/packages/app-web/wrangler.jsonc" \
    --dry-run
  exit 0
fi

echo "Deploying app Worker..."
bun --bun run --cwd "$REPO_ROOT/packages/app-web" deploy
