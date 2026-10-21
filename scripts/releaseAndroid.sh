#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIER="${1:-}"

case "$TIER" in
  production) SECRETS_TIER=prod PACKAGE_NAME=com.balebase.app FLAVOR=production ;;
  staging) SECRETS_TIER=staging PACKAGE_NAME=com.balebase.staging.app FLAVOR=staging ;;
  *)
    echo "Usage: $0 production|staging" >&2
    exit 1
    ;;
esac

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_tier_env "$SECRETS_TIER" "$REPO_ROOT"
SECRETS_DIR="$REPO_ROOT/.secrets/$SECRETS_TIER"
PLAY_KEY="$SECRETS_DIR/google-play-service-account-admin.json"
export BALEBASE_ANDROID_KEYSTORE="$SECRETS_DIR/balebase-upload.keystore"
for file in "$PLAY_KEY" "$BALEBASE_ANDROID_KEYSTORE"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: $file is missing." >&2
    exit 1
  fi
done
if [[ -z "${BALEBASE_ANDROID_KEYSTORE_PASS:-}" ]]; then
  echo "ERROR: Missing BALEBASE_ANDROID_KEYSTORE_PASS in .secrets/$SECRETS_TIER/app.env." >&2
  exit 1
fi

BALEBASE_ANDROID_VERSION_CODE="$(
  bun "$SCRIPT_DIR/googlePlay.ts" next-version-code "$PLAY_KEY" "$PACKAGE_NAME"
)"
export BALEBASE_ANDROID_VERSION_CODE
echo "Building $PACKAGE_NAME version code $BALEBASE_ANDROID_VERSION_CODE..."
bash "$SCRIPT_DIR/buildAndroid.sh" release "$TIER"

BUNDLE="$REPO_ROOT/packages/client/android/app/build/outputs/bundle/${FLAVOR}Release/app-$FLAVOR-release.aab"
bun "$SCRIPT_DIR/googlePlay.ts" upload-internal "$PLAY_KEY" "$PACKAGE_NAME" "$BUNDLE"
