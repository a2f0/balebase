# frozen_string_literal: true

# The readiness lanes' options, reports, and store checks, with the artifact
# and store inspections stubbed. See fastlaneLanes.test.ts.

def readiness_lane_error(fastfile, lane, platform, options)
  fastfile.runner.execute(lane, platform, options)
  nil
rescue FastlaneCore::Interface::FastlaneError => e
  e.message
end

def stub_readiness_inspections(inspected, stores)
  Readiness.define_singleton_method(:ios_artifact) do |report, path, expected|
    inspected << ['ios', path, expected]
    report.add('fixture.ios', 'verified', 'Artifact inspection called.')
  end
  Readiness.define_singleton_method(:android_artifact) do |report, path, expected, bundletool:|
    inspected << ['android', path, expected, bundletool]
    report.add('fixture.android', 'verified', 'Artifact inspection called.')
  end
  Readiness.define_singleton_method(:android_store) do |report, **options|
    stores << options
    report.add('fixture.store', 'verified', 'Store inspection called.')
  end
end

FastfileScenarios.define(:readiness_lanes) do |fastfile, dir|
  ipa = File.join(dir, 'readiness.ipa')
  aab = File.join(dir, 'readiness.aab')
  File.write(ipa, 'ipa fixture')
  File.write(aab, 'aab fixture')
  inspected = []
  stores = []
  stub_readiness_inspections(inspected, stores)
  error = ->(lane, platform, options) { readiness_lane_error(fastfile, lane, platform, options) }

  output = File.join(dir, 'reports', 'ios.json')
  fastfile.runner.execute(:readiness, :ios, { artifact: ipa, output: output, store: false })
  offline = JSON.parse(File.read(output))
  File.delete(output)
  strict = error.call(:readiness, :ios, { artifact: ipa, output: output, store: false, strict: true })
  strict_report = JSON.parse(File.read(output))['result']
  android_output = File.join(dir, 'reports', 'android.json')
  ENV['BUNDLETOOL_JAR'] = 'tools/from-env.jar'
  fastfile.runner.execute(:readiness, :android, { artifact: aab, output: android_output, track: 'beta' })
  android = JSON.parse(File.read(android_output))
  fastfile.runner.execute(
    :readiness, :android, { artifact: aab, output: android_output, store: false, bundletool: 'tools/explicit.jar' }
  )
  android_offline = JSON.parse(File.read(android_output))
  {
    ipa: ipa,
    aab: aab,
    offline: offline,
    strict: strict,
    strictReport: strict_report,
    android: android,
    androidOffline: android_offline,
    inspected: inspected,
    stores: stores.map { |options| options.merge(key_path: File.basename(options[:key_path])) },
    defaults: fastfile.send(:readiness_options, {}, 'ios', '/fixture/candidate.ipa'),
    errors: {
      overwrite: error.call(:readiness, :ios, { artifact: ipa, output: ipa, store: false }),
      receipt: error.call(:readiness, :ios, { artifact: ipa, output: "#{ipa}.build.json", store: false }),
      timeout: error.call(:readiness, :ios, { wait_timeout: 'abc' }),
      longTimeout: error.call(:readiness, :ios, { wait_timeout: '1801' }),
      track: error.call(:readiness, :android, { track: 'qa' }),
      store: error.call(:readiness, :ios, { store: 'maybe' })
    }
  }
end

FastfileScenarios.define(:ios_readiness_precheck) do |fastfile, dir|
  ipa = File.join(dir, 'precheck.ipa')
  File.write(ipa, 'ipa fixture')
  calls = []
  Readiness.define_singleton_method(:ios_artifact) { |_report, _path, _expected| nil }
  Readiness.define_singleton_method(:ios_store) do |report, app_identifier:, listing:, timeout:|
    calls << { app: app_identifier, listing: listing, timeout: timeout }
    report.add('fixture.store', 'verified', 'Store inspection called.')
  end
  fastfile.define_singleton_method(:load_store_secrets_env) { nil }
  fastfile.define_singleton_method(:app_store_connect_api_key_options) { { key_id: 'KEY' } }
  fastfile.define_singleton_method(:app_store_connect_api_key) { |_options| 'api-key' }
  mode = nil
  fastfile.define_singleton_method(:precheck) do |api_key:, app_identifier:, include_in_app_purchases:|
    calls << { precheck: app_identifier, api_key: api_key, purchases: include_in_app_purchases }
    # Precheck reports rejected metadata, and fastlane setup problems, as user errors.
    if mode == 'rejected'
      FastlaneCore::UI.user_error!('precheck found one or more potential problems that must be addressed')
    end
    FastlaneCore::UI.user_error!('private authentication diagnostic') if mode == 'error'

    true
  end
  reports = %w[pass rejected error skipped].to_h do |name|
    mode = name
    output = File.join(dir, 'precheck', "#{name}.json")
    fastfile.runner.execute(
      :readiness, :ios, { artifact: ipa, output: output, precheck: name != 'skipped', wait_timeout: '30' }
    )
    [name, JSON.parse(File.read(output))]
  end
  { reports: reports, calls: calls }
end
