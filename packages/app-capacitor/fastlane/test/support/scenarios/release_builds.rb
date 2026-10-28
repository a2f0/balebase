# frozen_string_literal: true

# What every release build checks before and after building: the bundled
# Capacitor config, the bundle's hosts, the merged PR, and the source receipt.
# See fastlaneLanes.test.ts.

FastfileScenarios.define(:bundled_release_config) do |fastfile, dir|
  {
    'bundled' => { appId: 'com.balebase.staging.app', server: { iosScheme: 'capacitor' } },
    'production' => { appId: 'com.balebase.app' },
    'liveReload' => { appId: 'com.balebase.staging.app', server: { url: 'http://192.168.1.20:5173' } }
  }.each { |name, config| File.write(File.join(dir, "#{name}.json"), JSON.generate(config)) }
  %w[bundled production liveReload missing].to_h do |name|
    path = File.join(dir, "#{name}.json")
    fastfile.send(:ensure_bundled_release_capacitor_config!, path, 'Android', 'bun run cap:sync:staging android')
    [name, 'accepted']
  rescue FastlaneCore::Interface::FastlaneError => e
    [name, e.message]
  end
end

FastfileScenarios.define(:release_url_guards) do |fastfile, _dir|
  ENV['VITE_API_URL'] = 'https://api-staging.balebase.com'
  ENV['VITE_APP_URL'] = 'https://app.balebase.com'
  fastfile.send(:ensure_native_release_service_urls!)
  nil
rescue StandardError => e
  { class: e.class.name, message: e.message }
end

FastfileScenarios.define(:release_lanes_refuse_foreign_hosts) do |fastfile, _dir|
  events = []
  Readiness.define_singleton_method(:source) { |_root| { 'commit' => 'a' * 40, 'dirty' => false } }
  fastfile.define_singleton_method(:sh) { |command| events << command }
  fastfile.define_singleton_method(:run_android_gradle) { |*arguments| events << arguments }
  ENV['VITE_APP_URL'] = 'https://app.balebase.com'
  %w[ios android].to_h do |platform|
    fastfile.runner.execute(:build_release, platform.to_sym, {})
    [platform, 'built']
  rescue FastlaneCore::Interface::FastlaneError => e
    [platform, { error: e.message, events: events.dup }]
  end
end

FastfileScenarios.define(:merged_release_pr) do |fastfile, _dir|
  prs = [
    { number: 150, mergedAt: '2026-10-20T23:30:00Z', title: 'older' },
    { number: 152, mergedAt: '2026-10-21T09:00:00Z', title: 'morning' },
    { number: 153, mergedAt: '2026-10-21T17:00:00Z', title: 'afternoon' },
    { number: 154, mergedAt: '2026-10-22T08:00:00Z', title: 'next day' }
  ]
  git_log = "1792569600\u0000feat: one (#140)\n1792605600\u0000chore: no PR\n1792591200\u0000fix: two (#141)\n"
  commands = []
  gh = { ok: true }
  fastfile.define_singleton_method(:release_command_available?) { |_command| true }
  fastfile.define_singleton_method(:release_command_output) do |*command|
    commands << command.first
    next [JSON.generate(prs), gh[:ok]] if command.first == 'gh'

    # Like git log --since/--until, only the release date's commits come back.
    [command.include?('--since=2026-10-21 00:00') ? git_log : '', true]
  end
  resolve = lambda do |options, env_prefix = 'ANDROID'|
    fastfile.send(:merged_release_pr_number, options, env_prefix)
  rescue FastlaneCore::Interface::FastlaneError => e
    "error: #{e.message}"
  end
  results = {
    github: resolve.call({ merged_date: '2026-10-21' }),
    explicit: resolve.call({ merged_pr_number: '77', merged_date: '2026-10-21' })
  }
  ENV['IOS_RELEASE_PR_NUMBER'] = '88'
  results[:env] = resolve.call({}, 'IOS')
  results[:invalid] = resolve.call({ merged_pr_number: '0' })
  results[:badDate] = resolve.call({ merged_date: '21/10/2026' })
  results[:noMatch] = resolve.call({ merged_date: '2026-11-01' })
  commands.clear
  gh[:ok] = false
  results[:gitFallback] = resolve.call({ merged_date: '2026-10-21' })
  results.merge(fallbackCommands: commands)
end

FastfileScenarios.define(:release_build_receipts) do |fastfile, dir|
  ipa = File.join(dir, 'receipt.ipa')
  File.write(ipa, 'ipa fixture')
  events = []
  source = { 'commit' => 'a' * 40, 'dirty' => false }
  Readiness.define_singleton_method(:source) do |root|
    events << ['source', root]
    source
  end
  Readiness.define_singleton_method(:record_build) do |artifact, recorded, root:|
    events << ['receipt', artifact, recorded, root]
  end
  fastfile.define_singleton_method(:sh) { |command| events << ['sh', command] }
  fastfile.define_singleton_method(:load_ios_release_secrets_env) { nil }
  fastfile.define_singleton_method(:load_android_release_secrets_env) { nil }
  fastfile.define_singleton_method(:next_ios_release_build_number) do |_options|
    { build_number: 7, version: '1.0', merged_pr_number: nil, testflight_latest_build_number: nil }
  end
  fastfile.define_singleton_method(:next_android_release_build_number) do |_options|
    { build_number: 7, merged_pr_number: nil, google_play_latest_build_number: nil }
  end
  fastfile.define_singleton_method(:require_ios_team_id!) { |_options| 'TEAM' }
  fastfile.define_singleton_method(:require_android_release_signing!) { nil }
  fastfile.define_singleton_method(:ensure_release_ios_capacitor_sync!) { nil }
  fastfile.define_singleton_method(:ensure_release_capacitor_sync!) { nil }
  SwiftPackagePins.define_singleton_method(:verify_around) { |_path, &block| block.call }
  fastfile.define_singleton_method(:with_ios_signing_keychain) { |&block| block.call }
  fastfile.define_singleton_method(:install_ios_appstore_signing_assets!) { 'profile' }
  fastfile.define_singleton_method(:configure_ios_manual_signing!) { |_profile, _team| nil }
  fastfile.define_singleton_method(:build_app) do |**|
    events << ['build_app']
    ipa
  end
  fastfile.define_singleton_method(:require_ios_testflight_assets!) { |path| [path] }
  fastfile.define_singleton_method(:run_android_gradle) { |*arguments| events << ['gradle', arguments.first] }
  aab = Fastlane::FastFile.const_get(:RELEASE_AAB_PATH)
  fastfile.define_singleton_method(:require_android_play_release_assets!) { [aab] }
  fastfile.runner.execute(:build_release, :ios, {})
  ios = events.dup
  events.clear
  fastfile.runner.execute(:build_release, :android, {})
  { ios: ios, android: events, aab: aab, ipa: ipa }
end
