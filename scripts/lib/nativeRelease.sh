#!/bin/sh
# shellcheck shell=sh
# Runs a native store release lane for one tier. The root mobile:build:* and
# mobile:upload:* scripts run it as
#   sh scripts/lib/nativeRelease.sh <android|ios> <build|upload> <tier> [fastlane-options...]
# Tests source it and call its functions.

native_release_usage() {
  cat <<'EOF'
Usage: sh scripts/lib/nativeRelease.sh <android|ios> <build|upload> <tier> [fastlane-options...]

Runs the platform's build_release or upload_release Fastlane lane for a tier in
packages/app-capacitor/nativeReleaseTargets.json. Uploads default to the store's
next build number unless the options or environment choose one, and print the
number they used.

Lanes, options, secrets, and build numbers:
packages/app-capacitor/README.md#releases
EOF
}

native_release_ensure_android_wrapper() {
  native_wrapper_jar="android/gradle/wrapper/gradle-wrapper.jar"
  if [ -f "$native_wrapper_jar" ]; then
    return 0
  fi

  # The wrapper JAR is binary, so cap:prepare restores it from the pinned
  # Capacitor CLI template, after rendering the native images it copies.
  bun run cap:prepare
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
      android:build_number:* | android:next_google_play:* | android:merged_pr_number:* | android:merged_date:* | \
        ios:build_number:* | ios:next_testflight:* | ios:merged_pr_number:* | ios:merged_date:*)
        return 0
        ;;
    esac
  done

  return 1
}

native_release_run_upload() {
  native_platform="$1"
  shift

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

  bundle exec fastlane "$native_platform" upload_release "$@"

  if [ -s "$native_build_number_file" ]; then
    echo "Build number: $(sed -n '1p' "$native_build_number_file")"
  else
    echo "Build number: unknown (Fastlane did not report one)"
  fi
}

native_release_main() {
  case "${1:-}" in
    -h | --help)
      native_release_usage
      return 0
      ;;
  esac

  # These POSIX-shell globals are intentionally reused by the helpers above;
  # every call in one release invocation carries the same target.
  native_platform="${1:-}"
  native_action="${2:-}"
  native_tier="${3:-}"
  case "$native_platform:$native_action" in
    android:build | android:upload | ios:build | ios:upload) ;;
    *)
      native_release_usage >&2
      echo "Error: unknown native release $native_platform $native_action; expected <android|ios> <build|upload>." >&2
      return 1
      ;;
  esac
  if [ -z "$native_tier" ]; then
    native_release_usage >&2
    echo "Error: name the release tier, such as production or staging." >&2
    return 1
  fi
  shift 3

  case "${1:-}" in
    -h | --help)
      native_release_usage
      return 0
      ;;
  esac

  native_script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
  cd "$native_script_dir/../../packages/app-capacitor" || return 1

  # The lanes reject an unknown tier and hold the bundle to the tier's own
  # HTTPS hosts (fastlane/lib/native_release_target.rb).
  export NATIVE_RELEASE_TIER="$native_tier"
  [ "$native_platform" != android ] || native_release_ensure_android_wrapper
  echo "Running ${native_platform} ${native_action}_release for ${native_tier} (NATIVE_RELEASE_TIER=${native_tier})"

  if [ "$native_action" = upload ]; then
    native_release_run_upload "$native_platform" "$@"
  else
    exec bundle exec fastlane "$native_platform" build_release "$@"
  fi
}

# Run only when executed, not when a test sources this file.
case "${0##*/}" in
  nativeRelease.sh)
    set -eu
    native_release_main "$@"
    ;;
esac
