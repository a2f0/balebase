#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/scripts" "$FIXTURE/bin" "$FIXTURE/packages/client/android" \
  "$FIXTURE/.secrets/prod" "$FIXTURE/.secrets/staging"
cp "$REPO_ROOT/scripts/releaseAndroid.sh" "$REPO_ROOT/scripts/buildAndroid.sh" \
  "$REPO_ROOT/scripts/cloudflareEnv.sh" "$FIXTURE/scripts/"
for tier in prod staging; do
  printf 'BALEBASE_ANDROID_KEYSTORE_PASS=%s-pass\n' "$tier" > "$FIXTURE/.secrets/$tier/app.env"
  : > "$FIXTURE/.secrets/$tier/balebase-upload.keystore"
  : > "$FIXTURE/.secrets/$tier/google-play-service-account-admin.json"
done
cat > "$FIXTURE/bin/bun" <<'EOF'
#!/usr/bin/env bash
printf 'bun %s VITE_API_URL=%s VITE_APP_URL=%s\n' "$*" "${VITE_API_URL:-}" "${VITE_APP_URL:-}" >> "$MOCK_LOG"
if [[ "$*" == *' next-version-code '* ]]; then
  printf '7\n'
fi
EOF
cat > "$FIXTURE/packages/client/android/gradlew" <<'EOF'
#!/usr/bin/env bash
printf 'gradlew %s code=%s keystore=%s pass=%s\n' "$*" "${BALEBASE_ANDROID_VERSION_CODE:-}" \
  "${BALEBASE_ANDROID_KEYSTORE:-}" "${BALEBASE_ANDROID_KEYSTORE_PASS:-}" >> "$MOCK_LOG"
EOF
chmod +x "$FIXTURE/bin/bun" "$FIXTURE/packages/client/android/gradlew"

export MOCK_LOG="$FIXTURE/commands.log"
expect_line() {
  grep -qxF "$1" "$MOCK_LOG" || {
    printf 'Missing command: %s\nLogged:\n' "$1" >&2
    cat "$MOCK_LOG" >&2
    exit 1
  }
}
release() {
  : > "$MOCK_LOG"
  PATH="$FIXTURE/bin:$PATH" bash "$FIXTURE/scripts/releaseAndroid.sh" "$@" > "$FIXTURE/output.log" 2>&1
}

# Each tier signs with its own key, bakes in its own backend, and uploads its
# own package at the version code Play reported.
check_tier() {
  local tier="$1" secrets="$2" package="$3" flavor="$4" Flavor="$5" api="$6" app="$7"
  local key="$FIXTURE/.secrets/$secrets/google-play-service-account-admin.json"
  release "$tier"
  expect_line "bun $FIXTURE/scripts/googlePlay.ts next-version-code $key $package VITE_API_URL= VITE_APP_URL="
  expect_line "bun run --cwd $FIXTURE mobile:sync VITE_API_URL=$api VITE_APP_URL=$app"
  expect_line "gradlew -p $FIXTURE/packages/client/android bundle${Flavor}Release code=7 keystore=$FIXTURE/.secrets/$secrets/balebase-upload.keystore pass=$secrets-pass"
  expect_line "bun $FIXTURE/scripts/googlePlay.ts upload-internal $key $package $FIXTURE/packages/client/android/app/build/outputs/bundle/${flavor}Release/app-$flavor-release.aab VITE_API_URL= VITE_APP_URL="
  [[ "$(wc -l < "$MOCK_LOG")" -eq 4 ]] || { echo "Unexpected commands for $tier" >&2; cat "$MOCK_LOG" >&2; exit 1; }
}
check_tier production prod com.balebase.app production Production \
  https://api.balebase.com https://app.balebase.com
check_tier staging staging com.balebase.staging.app staging Staging \
  https://api-staging.balebase.com https://app-staging.balebase.com

if release; then
  echo 'releaseAndroid.sh accepted a missing tier' >&2
  exit 1
fi
[[ ! -s "$MOCK_LOG" ]] || { echo 'releaseAndroid.sh ran commands without a tier' >&2; exit 1; }

: > "$FIXTURE/.secrets/staging/app.env"
if release staging; then
  echo 'releaseAndroid.sh accepted a missing keystore password' >&2
  exit 1
fi
[[ ! -s "$MOCK_LOG" ]] || { echo 'releaseAndroid.sh ran commands without a keystore password' >&2; exit 1; }

# Debug builds pick the flavor and backend without signing material.
: > "$MOCK_LOG"
PATH="$FIXTURE/bin:$PATH" bash "$FIXTURE/scripts/buildAndroid.sh" debug staging > "$FIXTURE/output.log"
expect_line "bun run --cwd $FIXTURE mobile:sync VITE_API_URL=https://api-staging.balebase.com VITE_APP_URL=https://app-staging.balebase.com"
expect_line "gradlew -p $FIXTURE/packages/client/android assembleStagingDebug code= keystore= pass="

echo 'Android release tier checks passed.'
