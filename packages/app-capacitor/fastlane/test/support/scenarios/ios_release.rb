# frozen_string_literal: true

# iOS release lanes: the signing keychain, build numbers, signing team,
# TestFlight options, and match profiles. See fastlaneLanes.test.ts.

FastfileScenarios.define(:signing_keychain_cleanup) do |fastfile, _dir|
  commands = []
  # Every fastlane shell helper (Actions.sh and the Action.sh that
  # create_keychain uses to list keychains) runs through sh_control_output.
  login = "    \"/Users/me/Library/Keychains/login.keychain-db\"\n"
  Fastlane::Actions.define_singleton_method(:sh_control_output) do |*command, **|
    line = command.join(' ')
    commands << line
    ['security default-keychain', 'security list-keychains -d user'].include?(line) ? login : ''
  end
  FastlaneCore::Helper.define_singleton_method(:keychain_path) { |name| "/tmp/#{name}-db" }
  [true, false].map do |exists|
    commands.clear
    fastfile.define_singleton_method(:ios_signing_keychain_exists?) { |_name| exists }
    fastfile.send(:create_ios_signing_keychain, 'balebase-test', 'secret')
    fastfile.send(:cleanup_ios_signing_keychain, 'balebase-test')
    commands.select { |line| line.start_with?('security default-keychain -s') }
  end
end

# The keychain path holds whitespace and non-ASCII text. This file is UTF-8
# source whatever the caller's locale, unlike a `ruby -e` script.
FastfileScenarios.define(:ios_build_flags) do |fastfile, _dir|
  FastlaneCore::Helper.define_singleton_method(:keychain_path) { |_name| '/tmp/Signing Keys/署名 keychain-db' }
  ENV['MATCH_KEYCHAIN_NAME'] = 'release keychain'
  Shellwords.split(fastfile.send(:ios_build_xcargs, { build_number: 2, version: '1.0' }, 'TEAM'))
end

FastfileScenarios.define(:testflight_external_waits) do |fastfile, _dir|
  [
    {},
    { distribute_external: true },
    { distribute_external: true, skip_waiting_for_build_processing: true }
  ].map { |options| fastfile.send(:testflight_skip_waiting_for_build_processing?, options) }
end

FastfileScenarios.define(:ios_release_options) do |fastfile, _dir|
  ENV['IOS_TEAM_ID'] = 'IOSTEAM'
  ENV['TEAM_ID'] = 'SHARED'
  attempt = lambda do |&block|
    block.call
  rescue FastlaneCore::Interface::FastlaneError => e
    "error: #{e.message}"
  end
  # TestFlight reports 0 for a version without builds.
  testflight = { latest: 0, versions: [] }
  fastfile.define_singleton_method(:app_store_configured?) { true }
  fastfile.define_singleton_method(:fetch_ios_testflight_build_number) do |version|
    testflight[:versions] << version
    testflight[:latest]
  end
  build = ->(options) { fastfile.send(:next_ios_release_build_number, options) }

  builds = { explicit: build.call({ build_number: '5', version: '2.0.0' }) }
  ENV['APPLE_BUILD_NUMBER'] = '6'
  builds[:appleEnvironment] = build.call({})
  ENV.delete('APPLE_BUILD_NUMBER')
  builds[:firstOfVersion] = build.call({ next_testflight: true })
  testflight[:latest] = 300
  builds[:aheadOfMerged] = build.call({ merged_pr_number: '153' })

  {
    builds: builds,
    testflightVersions: testflight[:versions],
    teamFromIosName: fastfile.send(:ios_team_id, {}),
    teamOption: fastfile.send(:ios_team_id, { team_id: 'OPTION' }),
    missingTeam: attempt.call do
      ENV.delete('IOS_TEAM_ID')
      ENV.delete('TEAM_ID')
      fastfile.send(:require_ios_team_id!, {})
    end,
    groups: fastfile.send(:testflight_groups, { groups: ' Staff, ,Beta ' }),
    emptyGroups: fastfile.send(:testflight_groups, { groups: ' , ' }),
    externalWithoutGroups: attempt.call do
      fastfile.send(:require_testflight_distribution_options!, { distribute_external: true })
    end,
    submission: [
      fastfile.send(:testflight_skip_submission?, {}),
      fastfile.send(:testflight_skip_submission?, { distribute_external: true })
    ]
  }
end

FastfileScenarios.define(:ios_profiles) do |fastfile, _dir|
  calls = []
  fastfile.define_singleton_method(:load_ios_release_secrets_env) { nil }
  fastfile.define_singleton_method(:with_ios_signing_keychain) do |&block|
    calls << 'keychain'
    block.call
  end
  fastfile.define_singleton_method(:app_store_connect_api_key_options) { { key_id: 'KEY' } }
  fastfile.define_singleton_method(:app_store_connect_api_key) { |options| "api-key:#{options[:key_id]}" }
  fastfile.define_singleton_method(:match) { |options| calls << options }
  fastfile.runner.execute(:profiles, :ios, {})
  fastfile.runner.execute(:profiles, :ios, { force: true })
  {
    version: fastfile.send(:ios_release_version, {}),
    explicitVersion: fastfile.send(:ios_release_version, { version: '2.0.0' }),
    calls: calls
  }
end
