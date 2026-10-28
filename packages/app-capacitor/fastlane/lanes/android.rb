# frozen_string_literal: true

require 'shellwords'
require_relative '../lib/lane_options'
require_relative '../lib/native_release_target'
require_relative '../lib/readiness_artifacts'
require_relative '../lib/readiness_stores'
require_relative '../lib/release_build_number'

ANDROID_DIR = File.expand_path('../../android', __dir__)
ANDROID_ASSETS_DIR = File.join(ANDROID_DIR, 'app/src/main/assets')
ANDROID_BUILD_VARIANT = NATIVE_RELEASE_TARGET.fetch(:android_build_variant)
ANDROID_BUILD_VARIANT_TASK = native_release_android_build_variant_task
ANDROID_UPLOAD_KEYSTORE_PATH = File.join(NATIVE_SECRETS_DIR, 'balebase-upload.keystore')
ANDROID_RELEASE_SIGNING_ENV_NAMES = %w[
  ANDROID_KEYSTORE_STORE_PASS
  ANDROID_KEYSTORE_KEY_PASS
].freeze
DEBUG_APK_PATH = File.join(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk')
ANDROID_OUTPUT_DIR = File.join(ANDROID_DIR, 'app/build/outputs')
RELEASE_APK_PATH = File.join(ANDROID_OUTPUT_DIR, "apk/#{ANDROID_BUILD_VARIANT}/app-#{ANDROID_BUILD_VARIANT}.apk")
ANDROID_RELEASE_ARTIFACT_RELATIVE_PATHS = native_release_android_artifact_relative_paths
RELEASE_AAB_PATH = File.join(ANDROID_OUTPUT_DIR, ANDROID_RELEASE_ARTIFACT_RELATIVE_PATHS.fetch(:aab))
RELEASE_MAPPING_PATH = File.join(ANDROID_OUTPUT_DIR, ANDROID_RELEASE_ARTIFACT_RELATIVE_PATHS.fetch(:mapping))
RELEASE_NATIVE_DEBUG_SYMBOLS_PATH = File.join(
  ANDROID_OUTPUT_DIR,
  ANDROID_RELEASE_ARTIFACT_RELATIVE_PATHS.fetch(:native_debug_symbols)
)
RELEASE_PLAY_ASSET_PATHS = [
  RELEASE_AAB_PATH,
  RELEASE_MAPPING_PATH,
  RELEASE_NATIVE_DEBUG_SYMBOLS_PATH
].freeze
ANDROID_RELEASE_VERSION_CODE_PROPERTY = 'balebaseVersionCode'
# What the readiness lane expects the App Bundle to hold. The merged manifest
# asks only for INTERNET, which the WebView needs, and AndroidX's permission for
# its own unexported receivers. Release builds are not minified.
ANDROID_READINESS_EXPECTATIONS = {
  identifier: NATIVE_APP_IDENTIFIER,
  permissions: %W[android.permission.INTERNET #{NATIVE_APP_IDENTIFIER}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION],
  minified: false
}.freeze

def connected_android_device_serials
  adb_output = `adb devices`
  serials = adb_output
            .lines
            .drop(1)
            .map(&:strip)
            .reject(&:empty?)
            .map { |line| line.split(/\s+/, 2) }
            .select { |parts| parts[1] == 'device' }
            .map { |parts| parts[0] }

  [serials, adb_output]
end

def requested_android_device_serial(serials)
  requested_serial = ENV.fetch('ANDROID_SERIAL', '').strip
  return nil if requested_serial.empty?
  return requested_serial if serials.include?(requested_serial)

  UI.important(
    "ANDROID_SERIAL=#{requested_serial} is not connected; falling back to auto-detected device."
  )
  nil
end

def preferred_android_device_serial(serials)
  serials.find { |serial| serial.start_with?('emulator-') } || serials.first
end

def android_gradle_command
  gradle_path = File.join(ANDROID_DIR, 'gradlew')
  wrapper_jar_path = File.join(ANDROID_DIR, 'gradle/wrapper/gradle-wrapper.jar')
  if File.file?(gradle_path) && File.executable?(gradle_path) && File.file?(wrapper_jar_path)
    return Shellwords.escape(gradle_path)
  end

  UI.user_error!('The Gradle wrapper JAR is missing. Run `bun run cap:prepare` in packages/app-capacitor.')
end

def run_android_gradle(*arguments)
  gradle_arguments = arguments.flatten.map { |argument| Shellwords.escape(argument.to_s) }.join(' ')
  sh("#{android_gradle_command} #{gradle_arguments} -p #{Shellwords.escape(ANDROID_DIR)}")
end

def resolve_android_device_serial
  serials, adb_output = connected_android_device_serials
  requested_serial = requested_android_device_serial(serials)
  return requested_serial unless requested_serial.nil?

  preferred_serial = preferred_android_device_serial(serials)
  return preferred_serial unless preferred_serial.nil?

  UI.user_error!(
    "No connected Android device/emulator found. `adb devices` output:\n#{adb_output}"
  )
end

def install_android_apk(apk_path)
  UI.user_error!("APK does not exist: #{apk_path}") unless File.exist?(apk_path)

  serial = resolve_android_device_serial
  escaped_serial = Shellwords.escape(serial)
  escaped_apk_path = Shellwords.escape(apk_path)

  sh("adb -s #{escaped_serial} wait-for-device")
  sh("adb -s #{escaped_serial} install -r #{escaped_apk_path}")
end

def ensure_release_capacitor_sync!
  ensure_bundled_release_capacitor_config!(
    File.join(ANDROID_ASSETS_DIR, 'capacitor.config.json'),
    'Android',
    "bun run #{NATIVE_CAPACITOR_SYNC_SCRIPT} android"
  )
end

def load_android_release_secrets_env
  load_native_release_secrets_env
end

GOOGLE_PLAY_BUILD_NUMBER_NAMES = ReleaseBuildNumber::Names.new(
  platform: 'Android',
  env_prefix: 'ANDROID',
  store: 'Google Play',
  credentials: 'Google Play credentials',
  guard: 'Google Play version-code guard',
  next_option: :next_google_play,
  skip_option: :skip_google_play_version_guard,
  # ANDROID_VERSION_CODE is the name Gradle reads outside the lanes.
  build_number_env_names: %w[ANDROID_BUILD_NUMBER ANDROID_VERSION_CODE]
)

# Google Play's side of ReleaseBuildNumber: its latest version code across the
# queried tracks and the app's uploads.
def google_play_build_number_store(options)
  tracks = google_play_tracks(options)
  ReleaseBuildNumber::Store.new(
    names: GOOGLE_PLAY_BUILD_NUMBER_NAMES,
    configured: -> { google_play_configured? },
    latest: -> { latest_google_play_build_number(tracks).last },
    scope: "tracks #{tracks.join(', ')}"
  )
end

def next_android_release_build_number(options)
  release_build = ReleaseBuildNumber.resolve(google_play_build_number_store(options), options)
  {
    build_number: release_build.fetch(:build_number),
    google_play_latest_build_number: release_build.fetch(:store_build_number),
    merged_pr_number: release_build.fetch(:merged_pr_number)
  }
end

def require_android_release_signing!
  unless File.file?(ANDROID_UPLOAD_KEYSTORE_PATH)
    UI.user_error!("Android upload keystore does not exist: #{ANDROID_UPLOAD_KEYSTORE_PATH}")
  end

  missing_names = ANDROID_RELEASE_SIGNING_ENV_NAMES.select { |name| ENV.fetch(name, '').empty? }
  return if missing_names.empty?

  UI.user_error!(
    "Android release signing is not configured. Missing #{missing_names.join(', ')} " \
    "in the environment, #{NATIVE_SHARED_ENV_PATH}, or #{NATIVE_APP_ENV_PATH}."
  )
end

def android_play_release_asset_paths
  RELEASE_PLAY_ASSET_PATHS.select { |path| File.file?(path) }
end

def require_android_play_release_assets!
  assets = android_play_release_asset_paths
  UI.user_error!("Android App Bundle was not created: #{RELEASE_AAB_PATH}") unless assets.include?(RELEASE_AAB_PATH)

  assets
end

def print_android_play_release_assets(assets)
  UI.success('Google Play release assets:')
  assets.each { |asset| UI.message(asset) }
end

def android_play_release_result(release_build, assets)
  {
    assets: assets,
    build_number: release_build.fetch(:build_number),
    google_play_latest_build_number: release_build.fetch(:google_play_latest_build_number),
    merged_pr_number: release_build.fetch(:merged_pr_number)
  }
end

def google_play_upload_track(options)
  lane_option(options, :track, 'GOOGLE_PLAY_TRACK', 'internal')
end

def google_play_release_status(options)
  lane_option(options, :release_status, 'GOOGLE_PLAY_RELEASE_STATUS', 'completed')
end

def google_play_validate_only?(options)
  lane_boolean_option(options, :validate_only, 'GOOGLE_PLAY_VALIDATE_ONLY', false)
end

def google_play_release_binary_upload_options(release_result)
  options = {
    package_name: NATIVE_APP_IDENTIFIER,
    json_key: require_existing_file!(google_play_json_key_path, 'Google Play JSON key'),
    aab: RELEASE_AAB_PATH
  }
  mapping_paths = release_result.fetch(:assets) - [RELEASE_AAB_PATH]
  options[:mapping_paths] = mapping_paths unless mapping_paths.empty?
  options
end

def google_play_release_content_skip_options
  {
    skip_upload_apk: true,
    skip_upload_metadata: true,
    skip_upload_changelogs: true,
    skip_upload_images: true,
    skip_upload_screenshots: true
  }
end

def upload_android_play_release_options(options, release_result)
  google_play_release_binary_upload_options(release_result).merge(
    google_play_release_content_skip_options,
    track: google_play_upload_track(options),
    release_status: google_play_release_status(options),
    validate_only: google_play_validate_only?(options)
  )
end

def record_android_release_build_number(build_number)
  UI.success("Android release build number: #{build_number}")
  output_path = ENV.fetch('ANDROID_RELEASE_BUILD_NUMBER_FILE', nil)
  return if output_path.to_s.empty?

  File.write(output_path, "#{build_number}\n")
end

def google_play_readiness_track(options)
  track = google_play_upload_track(options).to_s
  return track if GOOGLE_PLAY_DEFAULT_TRACKS.include?(track)

  UI.user_error!("Unsupported Play track #{track.inspect}; use one of #{GOOGLE_PLAY_DEFAULT_TRACKS.join(', ')}")
end

def bundletool_path(options)
  tool = lane_option(options, :bundletool, 'BUNDLETOOL_JAR')
  tool && File.expand_path(tool, NATIVE_REPO_ROOT)
end

def upload_android_play_release_result(options, release_result)
  {
    build_number: release_result.fetch(:build_number),
    google_play_latest_build_number: release_result.fetch(:google_play_latest_build_number),
    merged_pr_number: release_result.fetch(:merged_pr_number),
    track: google_play_upload_track(options),
    release_status: google_play_release_status(options),
    validate_only: google_play_validate_only?(options),
    assets: release_result.fetch(:assets)
  }
end

platform :android do
  desc 'Build a debug APK for sideloading'
  lane :build_debug_apk do
    sh('bun run build')
    sh('bun run cap:sync:debug android')
    run_android_gradle('assembleDebug')
  end

  desc 'Build a release APK for sideloading'
  lane :build_release_apk do
    sh('bun run build')
    sh("bun run #{NATIVE_CAPACITOR_SYNC_SCRIPT} android")
    ensure_release_capacitor_sync!
    run_android_gradle("assemble#{ANDROID_BUILD_VARIANT_TASK}")
  end

  # Writes a source/hash receipt (<aab>.build.json) beside the bundle, which the
  # readiness lane checks.
  desc 'Build a signed release App Bundle without uploading it (build_number:)'
  lane :build_release do |options|
    source = release_source
    load_android_release_secrets_env
    release_build = next_android_release_build_number(options)
    require_android_release_signing!
    sh('bun run build:release android')
    sh("bun run #{NATIVE_CAPACITOR_SYNC_SCRIPT} android")
    ensure_release_capacitor_sync!
    run_android_gradle(
      "bundle#{ANDROID_BUILD_VARIANT_TASK}",
      "-P#{ANDROID_RELEASE_VERSION_CODE_PROPERTY}=#{release_build.fetch(:build_number)}"
    )
    assets = require_android_play_release_assets!
    Readiness.record_build(RELEASE_AAB_PATH, source, root: NATIVE_REPO_ROOT)
    print_android_play_release_assets(assets)
    android_play_release_result(release_build, assets)
  end

  desc 'Run build_release, then upload to a Google Play track (build_number:, track:internal, release_status:completed)'
  lane :upload_release do |options|
    release_result = build_release(options)
    upload_to_play_store(upload_android_play_release_options(options, release_result))
    record_android_release_build_number(release_result.fetch(:build_number))
    upload_android_play_release_result(options, release_result)
  end

  # docs/readiness.md describes the options.
  desc 'Inspect an existing AAB and its Play state and write a redacted readiness report, without uploading or ' \
       'committing edits (artifact:, output:, track:internal, bundletool:, store:false, strict:true)'
  lane :readiness do |options|
    artifact, output = readiness_options(options, 'android', RELEASE_AAB_PATH)
    track = google_play_readiness_track(options)
    store = readiness_store?(options)
    strict = readiness_strict?(options)
    report = Readiness::Report.new('android', artifact, NATIVE_REPO_ROOT)
    Readiness.android_artifact(report, artifact, ANDROID_READINESS_EXPECTATIONS, bundletool: bundletool_path(options))
    if store
      Readiness.android_store(report, package: NATIVE_APP_IDENTIFIER, key_path: google_play_json_key_path,
                                      listing: STORE_LISTING, track: track)
    else
      report.add('store.android', 'unverified', 'Store inspection explicitly skipped.')
    end
    finish_readiness(report, output, strict)
  end

  desc 'Build and install the debug APK on a connected device'
  lane :install_debug do
    build_debug_apk
    install_android_apk(DEBUG_APK_PATH)
  end

  desc 'Build and install the release APK on a connected device'
  lane :install_release do
    build_release_apk
    install_android_apk(RELEASE_APK_PATH)
  end

  desc 'Build and install an APK on a connected device (build_type:debug or release, or ANDROID_BUILD_TYPE)'
  lane :sideload do |options|
    build_type = options[:build_type] || ENV.fetch('ANDROID_BUILD_TYPE', 'debug')

    case build_type.downcase
    when 'debug'
      install_debug
    when 'release'
      install_release
    else
      UI.user_error!("Unknown Android build type: #{build_type}. Expected debug or release.")
    end
  end

  desc 'Run Android unit tests'
  lane :test do
    run_android_gradle('test')
  end

  desc 'Clean Android build artifacts'
  lane :clean do
    run_android_gradle('clean')
  end
end
