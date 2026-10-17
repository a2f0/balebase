#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_ROOT="$REPO_ROOT/packages/client"
BUILD_TARGET="${1:-debug}"

case "$BUILD_TARGET" in
  debug) GRADLE_TASK=assembleDebug ;;
  release) GRADLE_TASK=bundleRelease ;;
  *) echo "Usage: $0 [debug|release]" >&2; exit 1 ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [debug|release]" >&2
  exit 1
fi

bun run --cwd "$REPO_ROOT" mobile:sync
if [[ "$BUILD_TARGET" == release ]]; then
  echo "Building an unsigned app bundle; configure an upload key before distribution."
fi
exec "$CLIENT_ROOT/android/gradlew" -p "$CLIENT_ROOT/android" "$GRADLE_TASK"
