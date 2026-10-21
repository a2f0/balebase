#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_ROOT="$REPO_ROOT/packages/client"
BUILD_TARGET="${1:-debug}"
TIER="${2:-production}"
usage() {
  echo "Usage: $0 [debug|release] [production|staging]" >&2
  exit 1
}

case "$BUILD_TARGET" in
  debug) GRADLE_TASK=assemble GRADLE_BUILD_TYPE=Debug ;;
  release) GRADLE_TASK=bundle GRADLE_BUILD_TYPE=Release ;;
  *) usage ;;
esac
# The tier picks the Gradle flavor and the backend baked into the web bundle;
# both override any VITE_* values in packages/client/.env.mobile.local.
case "$TIER" in
  production)
    GRADLE_FLAVOR=Production
    export VITE_API_URL=https://api.balebase.com
    export VITE_APP_URL=https://app.balebase.com
    ;;
  staging)
    GRADLE_FLAVOR=Staging
    export VITE_API_URL=https://api-staging.balebase.com
    export VITE_APP_URL=https://app-staging.balebase.com
    ;;
  *) usage ;;
esac
if [[ $# -gt 2 ]]; then
  usage
fi

bun run --cwd "$REPO_ROOT" mobile:sync
if [[ "$BUILD_TARGET" == release && -z "${BALEBASE_ANDROID_KEYSTORE:-}" ]]; then
  echo "Building an unsigned app bundle; scripts/releaseAndroid.sh signs and uploads it."
fi
exec "$CLIENT_ROOT/android/gradlew" -p "$CLIENT_ROOT/android" \
  "$GRADLE_TASK$GRADLE_FLAVOR$GRADLE_BUILD_TYPE"
