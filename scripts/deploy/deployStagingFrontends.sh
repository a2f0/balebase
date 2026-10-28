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
load_cloudflare_tier_env staging "$REPO_ROOT"

cd "$REPO_ROOT"
# Fail before building or uploading unless both existing domains match their
# intended Workers. Regenerate only the two frontend configs from current JSONC.
bun scripts/deploy/prepareStagingFrontends.ts
build_staging_frontends "$REPO_ROOT"
deploy_staging_frontends "$REPO_ROOT"
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  DEPLOY_TIER=staging bash "$SCRIPT_DIR/verifyDeployment.sh"
fi
