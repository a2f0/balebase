# frozen_string_literal: true

# Runs ReleaseBuildNumber through its public interface with each platform's
# names and a fake store, and prints {platform => {case => outcome}} as JSON.
# An outcome holds the result or error, the store calls, and the log lines.

require 'json'
require 'fastlane_core'
require_relative '../../lib/release_build_number'

PLATFORM_NAMES = {
  'android' => ReleaseBuildNumber::Names.new(
    platform: 'Android', env_prefix: 'ANDROID', store: 'Google Play', credentials: 'Google Play credentials',
    guard: 'Google Play version-code guard', next_option: :next_google_play,
    skip_option: :skip_google_play_version_guard, build_number_env_names: %w[ANDROID_BUILD_NUMBER ANDROID_VERSION_CODE]
  ),
  'ios' => ReleaseBuildNumber::Names.new(
    platform: 'iOS', env_prefix: 'IOS', store: 'TestFlight', credentials: 'App Store Connect credentials',
    guard: 'TestFlight build-number guard', next_option: :next_testflight,
    skip_option: :skip_testflight_version_guard, build_number_env_names: %w[IOS_BUILD_NUMBER APPLE_BUILD_NUMBER]
  )
}.freeze

def capture_logs(logs)
  %i[message important].each do |level|
    FastlaneCore::UI.define_singleton_method(level) { |text| logs << text }
  end
end

def with_env(values)
  saved = values.keys.to_h { |name| [name, ENV.fetch(name, nil)] }
  values.each { |name, value| ENV[name] = value }
  yield
ensure
  saved.each { |name, value| ENV[name] = value }
end

def fake_store(names, calls, configured:, latest:)
  ReleaseBuildNumber::Store.new(
    names: names,
    configured: lambda {
      calls << 'configured'
      configured
    },
    latest: lambda {
      calls << 'latest'
      raise latest if latest.is_a?(StandardError)

      latest
    },
    scope: 'fixture scope'
  )
end

def outcome(names, options, env: {}, configured: true, latest: 4)
  calls = []
  logs = []
  capture_logs(logs)
  value = with_env(env) do
    { result: ReleaseBuildNumber.resolve(fake_store(names, calls, configured: configured, latest: latest), options) }
  rescue FastlaneCore::Interface::FastlaneError => e
    { error: e.message }
  end
  value.merge(calls: calls, logs: logs)
end

def platform_cases(names)
  build_env, tool_env = names.build_number_env_names
  next_option = names.next_option
  skip_option = names.skip_option
  offline = RuntimeError.new('store offline')
  merged = { merged_pr_number: '153' }
  next_env = { "#{names.env_prefix}_RELEASE_#{next_option.upcase}" => 'true' }
  {
    explicitOption: outcome(names, { build_number: '9' }),
    explicitEnv: outcome(names, {}, env: { build_env => '10' }),
    toolEnv: outcome(names, {}, env: { tool_env => '11' }),
    optionBeatsEnv: outcome(names, { build_number: '9' }, env: { build_env => '10' }),
    aliasesIgnored: outcome(names, { version_code: '42', apple_build_number: '44', **merged }, configured: false),
    invalidExplicit: outcome(names, { build_number: '0' }),
    conflict: outcome(names, { build_number: '9', next_option => true }),
    next: outcome(names, { next_option => true }),
    nextFromEnv: outcome(names, {}, env: next_env, latest: nil),
    nextSkipped: outcome(names, { next_option => true, skip_option => true }),
    nextWithoutCredentials: outcome(names, { next_option => true }, configured: false),
    nextLookupFailure: outcome(names, { next_option => true }, latest: offline),
    automatic: outcome(names, merged),
    automaticStoreAhead: outcome(names, merged, latest: 300),
    automaticEnvPr: outcome(names, {}, env: { "#{names.env_prefix}_RELEASE_PR_NUMBER" => '88' }, latest: nil),
    automaticWithoutCredentials: outcome(names, merged, configured: false),
    automaticSkipped: outcome(names, merged, env: { skip_option.to_s.upcase => 'true' }),
    automaticLookupFailure: outcome(names, merged, latest: offline)
  }
end

puts JSON.generate(PLATFORM_NAMES.transform_values { |names| platform_cases(names) })
