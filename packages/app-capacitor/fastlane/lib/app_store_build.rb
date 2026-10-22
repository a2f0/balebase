# frozen_string_literal: true

# App Store draft icons come from the selected build, independently of uploads
# to TestFlight. Only an empty, unsubmitted draft may change marketing version.
class AppStoreBuild
  class SelectionError < StandardError; end

  def self.select(app, version:, build_number:)
    new(app, version, build_number).select
  end

  def initialize(app, version, build_number)
    @app = app
    @version = version
    @build_number = build_number
  end

  def select
    build = uploaded_build
    draft = editable_draft
    return draft if draft.build&.id == build.id

    draft.update(attributes: { versionString: @version }) if draft.version_string != @version
    draft.select_build(build_id: build.id)
    verify_selection(draft, build)
  end

  private

  def verify_selection(draft, build)
    selected = @app.get_app_store_versions(filter: { platform: 'IOS' }, includes: 'build')
                   .find { |item| item.id == draft.id }
    unless selected&.build&.id == build.id && selected.version_string == @version
      raise SelectionError, 'App Store Connect did not retain the selected build.'
    end

    selected
  end

  def uploaded_build
    builds = @app.get_builds(
      filter: { 'preReleaseVersion.version' => @version, version: @build_number },
      includes: 'preReleaseVersion'
    ).select { |build| build.pre_release_version&.platform == 'IOS' }
    unless builds.one?
      raise SelectionError, 'Expected exactly one uploaded iOS build for that version and build number.'
    end

    require_valid_build(builds.first)
  end

  def require_valid_build(build)
    unless build.processing_state == 'VALID' && !build.expired && build.icon_asset_token
      raise SelectionError, 'The uploaded build must be processed, unexpired, and contain an app icon.'
    end

    build
  end

  def editable_draft
    drafts = @app.get_app_store_versions(
      filter: { platform: 'IOS', appVersionState: 'PREPARE_FOR_SUBMISSION' }, includes: 'build'
    )
    raise SelectionError, 'Expected exactly one iOS version in Prepare for Submission.' unless drafts.one?

    draft = drafts.first
    if draft.version_string != @version && draft.build
      raise SelectionError, 'Cannot rename a draft that already has a selected build.'
    end

    draft
  end
end
