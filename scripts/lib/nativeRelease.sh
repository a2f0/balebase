# shellcheck shell=sh
# Shared implementation for native store build/upload wrappers. Source this file
# and call native_release_main with platform, action, and tier.

native_release_default_url() {
  case "$1:$2" in
    production:VITE_API_URL) printf '%s\n' "https://api.balebase.com" ;;
    production:VITE_APP_URL) printf '%s\n' "https://app.balebase.com" ;;
    staging:VITE_API_URL) printf '%s\n' "https://api-staging.balebase.com" ;;
    staging:VITE_APP_URL) printf '%s\n' "https://app-staging.balebase.com" ;;
    *) return 1 ;;
  esac
}

native_release_usage() {
  native_platform="$1"
  native_action="$2"
  native_tier="$3"
  native_action_description="Build"
  [ "$native_action" != upload ] || native_action_description="Build and upload"

  cat <<EOF
Usage: $(basename "$0") [fastlane-options...]

${native_action_description} the ${native_tier} ${native_platform} store release.

The native app identifier is selected by NATIVE_RELEASE_TIER:
  production  com.balebase.app
  staging     com.balebase.staging.app

Environment:
  VITE_API_URL  API URL inlined into the Capacitor bundle.
                Defaults to $(native_release_default_url "$native_tier" VITE_API_URL).
  VITE_APP_URL  Hosted app that emailed links open.
                Defaults to $(native_release_default_url "$native_tier" VITE_APP_URL).

Store credentials and signing values are loaded by Fastlane from the tier's
secrets folder (.secrets/prod or .secrets/staging): its shared.env, plus only
BALEBASE_ANDROID_KEYSTORE_PASS from its app.env. Explicitly exported
environment variables take precedence.
EOF

  if [ "$native_action" = upload ]; then
    cat <<'EOF'

Upload wrappers default to the next value in the selected app's store. Pass
build_number:<number> to select an explicit build number.
EOF
  else
    cat <<'EOF'

Build wrappers default to the larger of today's merged PR number and the store's
next value. Pass build_number:<number> to select an explicit build number.
EOF
  fi

  if [ "$native_platform" = android ]; then
    cat <<'EOF'

Android options:
  version_code:<number>       Alias for an explicit build number.
  next_google_play:true       Use the latest Play version code plus one.
  google_track:<track>        Upload track; defaults to internal.
  release_status:<status>     Upload release status; defaults to completed.
  validate_only:true          Validate the upload without publishing.

GOOGLE_PLAY_JSON_KEY_FILE (or SUPPLY_JSON_KEY) can override the default
.secrets/<tier>/google-play-service-account-admin.json key path.
EOF
  else
    cat <<'EOF'

iOS options:
  apple_build_number:<number> Alias for an explicit build number.
  next_testflight:true        Use the latest TestFlight build number plus one.
  changelog:<text>            Set the TestFlight What to Test notes.
  distribute_external:true    Distribute to external testers.
  groups:<name,name>          Select external TestFlight groups.
  skip_submission:true        Upload without submitting for review.

iOS builds import Match signing assets into an isolated per-run keychain with a
random password, then delete it after the archive.

App Store Connect authentication uses APP_STORE_CONNECT_KEY_ID,
APP_STORE_CONNECT_ISSUER_ID, and TEAM_ID. The private key defaults to
.secrets/<tier>/AuthKey_<key-id>.p8.
EOF
  fi
}

native_release_ensure_android_wrapper() {
  native_wrapper_jar="android/gradle/wrapper/gradle-wrapper.jar"
  if [ -f "$native_wrapper_jar" ]; then
    return 0
  fi

  # The wrapper JAR is binary, so cap:prepare restores it from the pinned
  # Capacitor CLI template instead of tracking it.
  bun scripts/prepareMobile.ts
}

native_release_url_host() {
  native_url_value="${1#*://}"
  native_url_authority="${native_url_value%%[/?#]*}"
  native_url_authority="${native_url_authority##*@}"
  native_url_host="${native_url_authority%%:*}"
  printf '%s\n' "$native_url_host" | tr '[:upper:]' '[:lower:]'
}

native_release_require_tier_host() {
  native_url_guard_name="$1"
  native_url_guard_tier="$2"
  native_url_guard_value="$3"

  native_url_guard_scheme="${native_url_guard_value%%:*}"
  native_url_guard_scheme="$(printf '%s\n' "$native_url_guard_scheme" | tr '[:upper:]' '[:lower:]')"
  if [ "$native_url_guard_scheme" != https ]; then
    echo "Error: $native_url_guard_name must use HTTPS for a store release." >&2
    return 1
  fi

  native_url_guard_host="$(native_release_url_host "$native_url_guard_value")"
  native_url_guard_expected_url="$(native_release_default_url "$native_url_guard_tier" "$native_url_guard_name")"
  native_url_guard_expected_host="$(native_release_url_host "$native_url_guard_expected_url")"
  if [ "$native_url_guard_host" = "$native_url_guard_expected_host" ]; then
    return 0
  fi

  echo "Error: $native_url_guard_name=$native_url_guard_value uses host $native_url_guard_host." >&2
  echo "A $native_url_guard_tier release must use $native_url_guard_expected_host." >&2
  return 1
}

native_release_guard_environment() {
  native_tier="$1"

  for native_url_name in VITE_API_URL VITE_APP_URL; do
    native_url_value="$(printenv "$native_url_name" || true)"
    if [ -z "$native_url_value" ]; then
      native_url_value="$(native_release_default_url "$native_tier" "$native_url_name")"
      export "$native_url_name=$native_url_value"
    fi
    native_release_require_tier_host "$native_url_name" "$native_tier" "$native_url_value" || return 1
  done
}

native_release_build_number_chosen() {
  native_platform="$1"
  shift

  if [ "$native_platform" = android ]; then
    if [ -n "${ANDROID_BUILD_NUMBER:-}" ] \
      || [ -n "${ANDROID_VERSION_CODE:-}" ] \
      || [ -n "${ANDROID_RELEASE_NEXT_GOOGLE_PLAY:-}" ] \
      || [ -n "${ANDROID_RELEASE_MERGED_PR_NUMBER:-}" ] \
      || [ -n "${ANDROID_RELEASE_PR_NUMBER:-}" ] \
      || [ -n "${ANDROID_RELEASE_MERGED_DATE:-}" ]; then
      return 0
    fi
  else
    if [ -n "${IOS_BUILD_NUMBER:-}" ] \
      || [ -n "${APPLE_BUILD_NUMBER:-}" ] \
      || [ -n "${IOS_RELEASE_NEXT_TESTFLIGHT:-}" ] \
      || [ -n "${IOS_RELEASE_MERGED_PR_NUMBER:-}" ] \
      || [ -n "${IOS_RELEASE_PR_NUMBER:-}" ] \
      || [ -n "${IOS_RELEASE_MERGED_DATE:-}" ]; then
      return 0
    fi
  fi

  for native_arg in "$@"; do
    case "$native_platform:$native_arg" in
      android:build_number:* | android:version_code:* | android:next_google_play:* | android:merged_pr_number:* | android:pr_number:* | android:merged_date:* | \
        ios:build_number:* | ios:apple_build_number:* | ios:next_testflight:* | ios:merged_pr_number:* | ios:pr_number:* | ios:merged_date:*)
        return 0
        ;;
    esac
  done

  return 1
}

native_release_bun_command() {
  native_platform="$1"
  native_action="$2"
  native_command_tier="$3"
  native_command_suffix=""
  if [ "$native_command_tier" = staging ]; then
    native_command_suffix=":staging"
  fi

  if [ "$native_platform" = android ]; then
    if [ "$native_action" = upload ]; then
      printf '%s%s\n' android:upload:google-play "$native_command_suffix"
    else
      printf '%s%s\n' android:build:google-play "$native_command_suffix"
    fi
  else
    if [ "$native_action" = upload ]; then
      printf '%s%s\n' ios:upload:testflight "$native_command_suffix"
    else
      printf '%s%s\n' ios:build:testflight "$native_command_suffix"
    fi
  fi
}

native_release_run_upload() {
  native_platform="$1"
  native_command="$2"
  shift 2

  if ! native_release_build_number_chosen "$native_platform" "$@"; then
    if [ "$native_platform" = android ]; then
      set -- "$@" next_google_play:true
    else
      set -- "$@" next_testflight:true
    fi
  fi

  native_build_number_file="$(mktemp "${TMPDIR:-/tmp}/${native_platform}-build-number.XXXXXX")"
  trap 'rm -f "$native_build_number_file"' EXIT
  if [ "$native_platform" = android ]; then
    export ANDROID_RELEASE_BUILD_NUMBER_FILE="$native_build_number_file"
  else
    export IOS_RELEASE_BUILD_NUMBER_FILE="$native_build_number_file"
  fi

  bun run "$native_command" "$@"

  if [ -s "$native_build_number_file" ]; then
    echo "Build number: $(sed -n '1p' "$native_build_number_file")"
  else
    echo "Build number: unknown (Fastlane did not report one)"
  fi
}

native_release_main() {
  # These POSIX-shell globals are intentionally reused by the helpers below;
  # every call in one release invocation carries the same target tuple.
  native_platform="$1"
  native_action="$2"
  native_tier="$3"
  shift 3

  case "$native_platform:$native_action:$native_tier" in
    android:build:production | android:build:staging | android:upload:production | android:upload:staging | ios:build:production | ios:build:staging | ios:upload:production | ios:upload:staging) ;;
    *)
      echo "Error: invalid native release target $native_platform:$native_action:$native_tier" >&2
      return 1
      ;;
  esac

  case "${1:-}" in
    -h | --help)
      native_release_usage "$native_platform" "$native_action" "$native_tier"
      return 0
      ;;
  esac

  native_script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
  native_package_dir="$native_script_dir/../packages/app-capacitor"
  cd "$native_package_dir" || return 1

  export NATIVE_RELEASE_TIER="$native_tier"
  native_release_guard_environment "$native_tier" || return 1
  [ "$native_platform" != android ] || native_release_ensure_android_wrapper
  native_command="$(native_release_bun_command "$native_platform" "$native_action" "$native_tier")"
  echo "${native_action}ing ${native_tier} ${native_platform} release (NATIVE_RELEASE_TIER=${native_tier})"
  echo "VITE_API_URL=$VITE_API_URL"

  if [ "$native_action" = upload ]; then
    native_release_run_upload "$native_platform" "$native_command" "$@"
  else
    exec bun run "$native_command" "$@"
  fi
}
