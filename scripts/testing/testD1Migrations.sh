#!/usr/bin/env bash
# Applies every API migration to a throwaway local D1 database. The unit tests
# apply them with bun:sqlite, whose limits are looser than D1's: D1 refuses,
# for example, a compound SELECT of more than five terms. Wrangler's local D1
# enforces D1's limits, so a migration that passes here deploys.
set -euo pipefail
repo="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
state="$(mktemp -d)"
trap 'rm -rf -- "$state"' EXIT
cd "$repo/packages/api"
CI=1 WRANGLER_SEND_METRICS=false bunx --bun --no-install wrangler d1 migrations apply DB \
  --local --persist-to "$state" --config wrangler.jsonc
