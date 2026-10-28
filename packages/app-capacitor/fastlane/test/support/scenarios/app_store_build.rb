# frozen_string_literal: true

# Selecting an uploaded build for the App Store draft. See
# fastlaneLanes.test.ts.

APP_STORE_BUILD_SCENARIOS = %w[
  empty repeat replace renamedSelected processing expired noIcon missing ambiguous noDraft inReview notRetained
].freeze
UploadedBuild = Struct.new(:id, :pre_release_version, :processing_state, :expired, :icon_asset_token)
PreReleaseVersion = Struct.new(:platform)
DraftVersion = Struct.new(:id, :version_string, :build, :app_version_state)
SelectedBuild = Struct.new(:id)

def uploaded_build_fixture(scenario)
  UploadedBuild.new(
    id: 'uploaded', pre_release_version: PreReleaseVersion.new(platform: 'IOS'),
    processing_state: scenario == 'processing' ? 'PROCESSING' : 'VALID',
    expired: scenario == 'expired', icon_asset_token: scenario == 'noIcon' ? nil : { 'templateUrl' => 'icon.png' }
  )
end

def draft_fixture(scenario, build, calls)
  selected = case scenario
             when 'repeat' then build
             when 'replace', 'renamedSelected' then SelectedBuild.new(id: 'old')
             end
  draft = DraftVersion.new(
    id: 'draft', version_string: %w[repeat replace].include?(scenario) ? '0.1.63' : '1.0',
    build: selected, app_version_state: scenario == 'inReview' ? 'IN_REVIEW' : 'PREPARE_FOR_SUBMISSION'
  )
  draft.define_singleton_method(:update) do |attributes:|
    calls << ['version', attributes]
    self.version_string = attributes.fetch(:versionString)
    self
  end
  draft.define_singleton_method(:select_build) do |build_id:|
    calls << ['build', build_id]
    self.build = build unless scenario == 'notRetained'
  end
  draft
end

def app_fixture(scenario, build, draft)
  app = Object.new
  app.define_singleton_method(:get_builds) do |filter:, includes:|
    raise 'Wrong build lookup' unless filter == { 'preReleaseVersion.version' => '0.1.63', version: '1' }
    raise 'Missing platform lookup' unless includes == 'preReleaseVersion'
    next [] if scenario == 'missing'
    next [build, build] if scenario == 'ambiguous'

    [build]
  end
  app.define_singleton_method(:get_app_store_versions) do |filter:, includes:|
    raise 'Wrong draft platform' unless filter[:platform] == 'IOS' && includes == 'build'
    next [] if scenario == 'noDraft'
    next [] if filter[:appVersionState] && filter[:appVersionState] != draft.app_version_state

    [draft]
  end
  app
end

FastfileScenarios.define(:app_store_build_select) do |_fastfile, _dir|
  APP_STORE_BUILD_SCENARIOS.to_h do |scenario|
    calls = []
    build = uploaded_build_fixture(scenario)
    app = app_fixture(scenario, build, draft_fixture(scenario, build, calls))
    outcome = begin
      AppStoreBuild.select(app, version: '0.1.63', build_number: '1').id
    rescue AppStoreBuild::SelectionError => e
      e.message
    end
    [scenario, { outcome: outcome, calls: calls }]
  end
end

FastfileScenarios.define(:select_store_build_lane) do |fastfile, _dir|
  calls = []
  fastfile.define_singleton_method(:load_store_secrets_env) { calls << 'credentials' }
  fastfile.define_singleton_method(:app_store_connect_api_key_options) { { key_id: 'KEY' } }
  fastfile.define_singleton_method(:app_store_connect_api_key) { |_options| calls << 'authenticate' }
  Spaceship::ConnectAPI::App.define_singleton_method(:find) do |identifier|
    calls << identifier
    'app'
  end
  AppStoreBuild.define_singleton_method(:select) do |app, version:, build_number:|
    calls << [app, version, build_number]
    DraftVersion.new(id: 'draft', version_string: version)
  end
  missing = begin
    fastfile.runner.execute(:select_store_build, :ios, {})
  rescue FastlaneCore::Interface::FastlaneError => e
    e.message
  end
  before = calls.dup
  selected = fastfile.runner.execute(:select_store_build, :ios, { version: '0.1.63', build_number: '1' })
  { missing: missing, before: before, selected: selected, calls: calls }
end
