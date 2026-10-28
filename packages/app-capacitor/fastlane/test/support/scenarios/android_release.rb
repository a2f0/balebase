# frozen_string_literal: true

# Android release lanes: Play version codes, build numbers, upload options,
# and signing. See fastlaneLanes.test.ts.

FastfileScenarios.define(:play_version_codes) do |fastfile, dir|
  ENV['GOOGLE_PLAY_JSON_KEY_FILE'] = File.join(dir, 'play.json')
  File.write(ENV.fetch('GOOGLE_PLAY_JSON_KEY_FILE'), '{}')
  calls = []
  client = Object.new
  client.define_singleton_method(:begin_edit) { |package_name:| calls << "begin:#{package_name}" }
  client.define_singleton_method(:aab_version_codes) { [3, 9] }
  client.define_singleton_method(:apks_version_codes) { [] }
  client.define_singleton_method(:abort_current_edit) { calls << 'abort' }
  fastfile.define_singleton_method(:google_play_supply_client) { client }
  fastfile.define_singleton_method(:google_play_version_codes_by_track) do |tracks|
    tracks.to_h { |track| [track, track == 'internal' ? ['4'] : []] }
  end
  latest = fastfile.send(:latest_google_play_build_number, %w[internal production])
  next_build = fastfile.send(:next_android_release_build_number, { next_google_play: true })
  { latest: latest, next: next_build, calls: calls }
end

FastfileScenarios.define(:android_release_options) do |fastfile, dir|
  ENV['GOOGLE_PLAY_JSON_KEY_FILE'] = File.join(dir, 'play-upload.json')
  File.write(ENV.fetch('GOOGLE_PLAY_JSON_KEY_FILE'), '{}')
  File.write(File.join(dir, 'balebase-upload.keystore'), '')
  ENV['ANDROID_KEYSTORE_STORE_PASS'] = ''
  ENV['ANDROID_KEYSTORE_KEY_PASS'] = ''
  play = { latest: 4 }
  fastfile.define_singleton_method(:latest_google_play_build_number) { |_tracks| [{}, play[:latest]] }
  build = ->(options) { fastfile.send(:next_android_release_build_number, options) }

  builds = {
    merged: build.call({ merged_pr_number: '153' }),
    next: build.call({ next_google_play: true }),
    explicit: build.call({ build_number: '9' })
  }
  ENV['ANDROID_VERSION_CODE'] = '11'
  builds[:gradleEnvironment] = build.call({})
  ENV.delete('ANDROID_VERSION_CODE')
  play[:latest] = 300
  builds[:aheadOfMerged] = build.call({ merged_pr_number: '153' })

  aab = Fastlane::FastFile.const_get(:RELEASE_AAB_PATH)
  upload = fastfile.send(:upload_android_play_release_options, {}, { assets: [aab, '/tmp/mapping.txt'] })
  override = fastfile.send(
    :upload_android_play_release_options,
    { track: 'alpha', release_status: 'draft', validate_only: true },
    { assets: [aab] }
  )
  signing = begin
    fastfile.send(:require_android_release_signing!)
    'ok'
  rescue FastlaneCore::Interface::FastlaneError => e
    e.message
  end
  {
    builds: builds,
    upload: upload.slice(:package_name, :json_key, :mapping_paths, :track, :release_status, :validate_only,
                         :skip_upload_metadata),
    aab: upload[:aab] == aab,
    override: override.slice(:track, :release_status, :validate_only, :mapping_paths),
    signing: signing
  }
end
