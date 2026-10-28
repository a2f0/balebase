# frozen_string_literal: true

# Each lane option has one name and keeps its environment fallback. See
# laneOptions.test.ts; build-number options are in releaseBuildNumber.test.ts.

FastfileScenarios.define(:lane_options) do |fastfile, _dir|
  results = {
    defaultTrack: fastfile.send(:google_play_upload_track, {}),
    track: fastfile.send(:google_play_upload_track, { track: 'beta' }),
    queriedTrack: fastfile.send(:google_play_tracks, { track: 'beta' }),
    defaultQueriedTracks: fastfile.send(:google_play_tracks, {}),
    releaseStatus: fastfile.send(:google_play_release_status, {}),
    teamOption: fastfile.send(:ios_team_id, { team_id: 'OPTION', apple_team_id: 'ALIAS' }),
    teamAliasOption: fastfile.send(:ios_team_id, { apple_team_id: 'ALIAS' }),
    iosVersion: fastfile.send(:explicit_ios_release_version, { version: '2.0.0' }),
    iosAppleVersionOption: fastfile.send(:explicit_ios_release_version, { apple_version: '2.0.1' }),
    mergedPrNumber: fastfile.send(:configured_merged_release_pr_number, { merged_pr_number: '47' }, 'ANDROID'),
    prNumberOption: fastfile.send(:configured_merged_release_pr_number, { pr_number: '48' }, 'ANDROID')
  }
  ENV['GOOGLE_PLAY_TRACK'] = 'alpha'
  results[:envTrack] = fastfile.send(:google_play_upload_track, {})
  ENV['TEAM_ID'] = 'SHARED'
  results[:teamEnv] = fastfile.send(:ios_team_id, {})
  ENV['APP_STORE_VERSION'] = '2.0.2'
  results[:iosAppleVersionEnv] = fastfile.send(:explicit_ios_release_version, {})
  ENV['ANDROID_RELEASE_PR_NUMBER'] = '49'
  results.merge(prNumberEnv: fastfile.send(:configured_merged_release_pr_number, {}, 'ANDROID'))
end
