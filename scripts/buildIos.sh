#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_ROOT="$REPO_ROOT/packages/client"
BUILD_TARGET="${1:-simulator}"

case "$BUILD_TARGET" in
  simulator|release) ;;
  *) echo "Usage: $0 [simulator|release]" >&2; exit 1 ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [simulator|release]" >&2
  exit 1
fi

bun run --cwd "$REPO_ROOT" mobile:sync

if [[ "$BUILD_TARGET" == release ]]; then
  echo "Building an unsigned device archive; configure signing in Xcode before distribution."
  exec xcodebuild -project "$CLIENT_ROOT/ios/App/App.xcodeproj" -scheme App \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$CLIENT_ROOT/ios/App/output/Balebase.xcarchive" \
    -derivedDataPath "$CLIENT_ROOT/ios/DerivedData" \
    CODE_SIGNING_ALLOWED=NO archive
fi

exec xcodebuild -project "$CLIENT_ROOT/ios/App/App.xcodeproj" -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$CLIENT_ROOT/ios/DerivedData" \
  CODE_SIGNING_ALLOWED=NO build
