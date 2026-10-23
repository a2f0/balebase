import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// balebase and nc keep identical copies of fastlane/lib/readiness*.rb and of
// this test, which checks the libraries without either repository's lanes.
const root = resolve(import.meta.dir, "../..");

const script = String.raw`
require 'digest'
require 'json'
require 'ostruct'
require 'tmpdir'
require 'zip'
require 'cfpropertylist'
require File.join(ARGV[0], 'fastlane/lib/readiness_artifacts')
require File.join(ARGV[0], 'fastlane/lib/readiness_stores')

APP = 'com.example.app'
WIDGET = 'com.example.app.widget'
GROUP = 'group.com.example.app'
EMAIL = 'NSPrivacyCollectedDataTypeEmailAddress'
USER_DEFAULTS = 'NSPrivacyAccessedAPICategoryUserDefaults'
LISTING = { locales: %w[en-US de-DE], screenshot_locale: 'en-US' }.freeze

def Readiness.source(_root) = { 'commit' => 'a' * 40, 'dirty' => false }

def xml(value)
  list = CFPropertyList::List.new
  list.value = CFPropertyList.guess(value)
  list.to_str(CFPropertyList::List::FORMAT_XML)
end

def status(report, id) = report.data[:checks].find { |check| check[:id] == id }&.fetch(:status)

results = {}

Dir.mktmpdir do |dir|
  artifact = File.join(dir, 'candidate.ipa')
  File.write(artifact, 'candidate bytes')
  report = -> { Readiness::Report.new('ios', artifact, dir) }
  results[:missing_receipt] = report.call.result
  Readiness.record_build(artifact, Readiness.source(dir))
  good = report.call
  results[:good_receipt] = good.result
  Readiness.record_build(artifact, { 'commit' => 'b' * 40, 'dirty' => false }, root: dir)
  results[:source_changed] = status(report.call, 'artifact.clean_source')
  Readiness.record_build(artifact, Readiness.source(dir))
  Readiness.manual_checks(good)
  results[:manual_remains_unknown] = good.result
  output = File.join(dir, 'private', 'report.json')
  good.write(output)
  results[:private_mode] = File.stat(output).mode & 0o777
  results[:written_result] = JSON.parse(File.read(output))['result']
  File.write(artifact, 'tampered bytes')
  results[:tampered] = report.call.result
  File.write("#{artifact}.build.json", 'not json')
  results[:bad_receipt] = report.call.result
  File.delete(artifact)
  results[:missing_artifact] = report.call.result
  failure = report.call
  failure.attempt('store') { raise 'secret-contact@example.com token-secret' }
  results[:redacted] = JSON.generate(failure.data)
end

Dir.mktmpdir do |dir|
  artifact = File.join(dir, 'candidate.ipa')
  File.write(artifact, 'fixture')
  Readiness.record_build(artifact, Readiness.source(dir))
  original_source = Readiness.method(:source)
  Readiness.define_singleton_method(:source) { |_| raise Errno::ENOENT }
  report = Readiness::Report.new('ios', artifact, dir)
  results[:missing_git] = report.data.merge(result: report.result)
  Readiness.define_singleton_method(:source, original_source)
end

now = 0
calls = 0
processing = OpenStruct.new(processing_state: 'PROCESSING')
build = Readiness.wait_for_build(timeout: 20, clock: -> { now }, sleeper: ->(seconds) { now += seconds }) do
  calls += 1
  processing
end
results[:timeout] = [now, calls, build.processing_state]
now = 0
calls = 0
build = Readiness.wait_for_build(timeout: 20, clock: -> { now }, sleeper: ->(seconds) { now += seconds }) do
  calls += 1
  OpenStruct.new(processing_state: calls == 1 ? 'PROCESSING' : 'INVALID')
end
results[:terminal] = [now, calls, build.processing_state]

# Real ZIP extraction catches library API changes, including absolute destinations.
Dir.mktmpdir do |dir|
  zip_path = File.join(dir, 'fixture.ipa')
  Zip::File.open(zip_path, create: true) do |zip|
    zip.get_output_stream('Payload/App.app/Info.plist') { |io| io.write('fixture') }
  end
  destination = File.join(dir, 'unpacked')
  Dir.mkdir(destination)
  Readiness.unpack(zip_path, destination)
  results[:unpacked] = File.read(File.join(destination, 'Payload/App.app/Info.plist'))
  unsafe = File.join(dir, 'unsafe.ipa')
  Zip::File.open(unsafe, create: true) { |zip| zip.get_output_stream('../escaped') { |io| io.write('no') } }
  begin
    Readiness.unpack(unsafe, destination)
  rescue RuntimeError
    results[:unsafe_rejected] = !File.exist?(File.join(dir, 'escaped'))
  end
end

# iOS artifacts: real plists in real IPAs, with codesign and security replaced.
original_command = Readiness.method(:command)
mode = :good
Readiness.define_singleton_method(:command) do |*args|
  case args.first
  when 'codesign'
    raise Errno::ENOENT if mode == :missing_codesign
    raise Readiness::CommandError, 'codesign failed' if mode == :bad_signature && args.include?('--verify')
    next '' if args.include?('--verify')

    id = args.last.end_with?('.appex') ? WIDGET : APP
    xml('get-task-allow' => mode == :debuggable, 'application-identifier' => "TEAM.#{id}",
        'com.apple.security.application-groups' => %i[missing_group no_groups].include?(mode) ? [] : [GROUP])
  when 'security'
    profile = { 'ExpirationDate' => mode == :expired ? Time.now - 3600 : Time.now + 3600 }
    profile['ProvisionedDevices'] = ['device'] if %i[development ad_hoc].include?(mode)
    profile['ProvisionsAllDevices'] = true if mode == :enterprise
    xml(profile)
  else
    raise "Unexpected command: #{args.first}"
  end
end

privacy_manifest = lambda do |scenario|
  collected = scenario == :other_collection ? 'NSPrivacyCollectedDataTypeName' : EMAIL
  reasons = scenario == :missing_reason ? [] : ['CA92.1']
  type = { 'NSPrivacyCollectedDataType' => collected, 'NSPrivacyCollectedDataTypeLinked' => true,
           'NSPrivacyCollectedDataTypeTracking' => scenario == :tracked_type,
           'NSPrivacyCollectedDataTypePurposes' => ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] }
  type['NSPrivacyCollectedDataTypePurposes'] = [] if scenario == :missing_purposes
  type['NSPrivacyCollectedDataTypePurposes'] = ['NSPrivacyCollectedDataTypePurposeAnalytics'] if scenario == :other_purpose
  type['NSPrivacyCollectedDataTypeLinked'] = false if scenario == :unlinked
  type.delete('NSPrivacyCollectedDataTypeLinked') if scenario == :undeclared_linked
  manifest = {
    'NSPrivacyTracking' => scenario == :tracking,
    'NSPrivacyCollectedDataTypes' => scenario == :duplicate_type ? [type, type] : [type],
    'NSPrivacyAccessedAPITypes' => [{ 'NSPrivacyAccessedAPIType' => USER_DEFAULTS,
                                      'NSPrivacyAccessedAPITypeReasons' => reasons }]
  }
  manifest.delete('NSPrivacyCollectedDataTypes') if scenario == :undeclared_collection
  manifest.delete('NSPrivacyTracking') if scenario == :undeclared_tracking
  xml(manifest)
end

build_ipa = lambda do |path, scenario, widget: true|
  Zip::File.open(path, create: true) do |zip|
    targets = ['Payload/App.app']
    targets << 'Payload/App.app/PlugIns/Widget.appex' if widget
    targets.each do |target|
      id = target.end_with?('.appex') ? WIDGET : APP
      info = { 'CFBundleIdentifier' => id, 'CFBundleShortVersionString' => '1.0', 'CFBundleVersion' => '12',
               'DTSDKName' => 'iphoneos26.0', 'MinimumOSVersion' => '18.0' }
      files = { 'Info.plist' => xml(info), 'PrivacyInfo.xcprivacy' => privacy_manifest.call(scenario),
                'embedded.mobileprovision' => 'signed fixture' }
      files.delete('embedded.mobileprovision') if scenario == :missing_profile
      files.delete('PrivacyInfo.xcprivacy') if scenario == :missing_privacy
      files.each { |name, contents| zip.get_output_stream("#{target}/#{name}") { |io| io.write(contents) } }
    end
  end
end

email_use = { linked: true, tracking: false, purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] }
privacy = { tracking: false, collected_data_types: { EMAIL => email_use },
            accessed_api_reasons: { USER_DEFAULTS => ['CA92.1'] } }
with_widget = { targets: { APP => [GROUP], WIDGET => [GROUP] }, privacy: privacy }
app_only = { targets: { APP => [] }, privacy: privacy }
Dir.mktmpdir do |dir|
  %i[good development ad_hoc enterprise expired debuggable missing_group tracking undeclared_tracking
     undeclared_collection other_collection missing_purposes other_purpose unlinked undeclared_linked tracked_type
     duplicate_type missing_reason missing_codesign bad_signature missing_profile missing_privacy].each do |scenario|
    mode = scenario
    artifact = File.join(dir, "#{scenario}.ipa")
    build_ipa.call(artifact, scenario)
    report = Readiness::Report.new('ios', artifact, dir)
    Readiness.ios_artifact(report, artifact, with_widget)
    results["ios_#{scenario}"] = report.data
  end
  mode = :no_groups
  artifact = File.join(dir, 'app-only.ipa')
  build_ipa.call(artifact, :good, widget: false)
  report = Readiness::Report.new('ios', artifact, dir)
  Readiness.ios_artifact(report, artifact, app_only)
  results[:ios_app_only] = report.data
  mode = :good
  report = Readiness::Report.new('ios', File.join(dir, 'good.ipa'), dir)
  Readiness.ios_artifact(report, File.join(dir, 'good.ipa'), app_only)
  results[:ios_unexpected_target] = report.data
end

module Spaceship
  module ConnectAPI
    module Platform
      IOS = 'IOS'
    end

    class App
      class << self
        attr_accessor :current, :requested

        def find(id)
          self.requested = id
          current
        end
      end
    end

    class Build
      class << self
        attr_accessor :current, :query

        def all(**query)
          self.query = query
          current
        end
      end
    end
  end
end

candidate = OpenStruct.new(version: '12', app_version: '1.0', processing_state: 'VALID', expired: false, id: 'candidate')
stale = OpenStruct.new(version: '99', app_version: '0.9', processing_state: 'VALID', expired: false, id: 'old')
Dir.mktmpdir do |dir|
  artifact = File.join(dir, 'fixture.ipa')
  File.write(artifact, 'fixture')
  %i[good wrong_selected reserved_phone missing_ipad no_review blank_contact stale_build no_version
     rejected].each do |scenario|
    # The candidate must be found by its exact version and build, never replaced by another build.
    rejected = OpenStruct.new(candidate.to_h.merge(processing_state: 'INVALID'))
    Spaceship::ConnectAPI::Build.current = { stale_build: [stale], rejected: [stale, rejected] }
                                           .fetch(scenario, [stale, candidate])
    shot = ->(state) { OpenStruct.new(asset_delivery_state: { 'state' => state }) }
    phone = shot.call(scenario == :reserved_phone ? 'AWAITING_UPLOAD' : 'COMPLETE')
    sets = [OpenStruct.new(screenshot_display_type: 'APP_IPHONE_67', app_screenshots: [phone])]
    unless scenario == :missing_ipad
      sets << OpenStruct.new(screenshot_display_type: 'APP_IPAD_PRO_3GEN_129', app_screenshots: [shot.call('COMPLETE')])
    end
    entry = OpenStruct.new(locale: 'en-US', description: 'Description', support_url: 'https://example.test',
                           get_app_screenshot_sets: sets)
    translated = OpenStruct.new(locale: 'de-DE', description: 'Beschreibung', support_url: 'https://example.test')
    translated.define_singleton_method(:get_app_screenshot_sets) { raise 'Only the screenshot locale has screenshots' }
    review = OpenStruct.new(contact_first_name: scenario == :blank_contact ? ' ' : 'First', contact_last_name: 'Last',
                            contact_phone: '123', contact_email: 'private@example.test', notes: 'Reviewer notes')
    selected = scenario == :wrong_selected ? OpenStruct.new(id: 'other') : candidate
    version = OpenStruct.new(build: selected, get_app_store_version_localizations: [entry, translated])
    version.define_singleton_method(:fetch_app_store_review_detail) do
      raise 'No data' if scenario == :no_review

      review
    end
    app = OpenStruct.new(id: 'app')
    app.define_singleton_method(:get_app_store_versions) do |**options|
      results[:store_includes] = options[:includes]
      scenario == :no_version ? [] : [version]
    end
    Spaceship::ConnectAPI::App.current = app
    report = Readiness::Report.new('ios', artifact, dir)
    report.data[:artifact].merge!(version: '1.0', build_number: '12')
    Readiness.ios_store(report, app_identifier: APP, listing: LISTING)
    results["store_#{scenario}"] = report.data
  end
  results[:store_app] = Spaceship::ConnectAPI::App.requested
  results[:build_states] = Spaceship::ConnectAPI::Build.query[:processing_states]
  report = Readiness::Report.new('ios', artifact, dir)
  Readiness.ios_store(report, app_identifier: APP, listing: LISTING)
  results[:store_unknown_candidate] = report.data
end

module Google
  module Apis
    module AndroidpublisherV3
      class AppEdit; end
    end
  end
end

service = Object.new
events = []
service.define_singleton_method(:insert_edit) do |*|
  events << 'insert'
  OpenStruct.new(id: 'temporary')
end
service.define_singleton_method(:delete_edit) { |*| events << 'delete' }
begin
  Readiness.with_play_edit(service, APP) do
    events << 'read'
    raise 'read failed'
  end
rescue RuntimeError
  nil
end
results[:play_cleanup] = events

# Android artifacts: real ZIP entries, with bundletool and jarsigner replaced.
Dir.mktmpdir do |dir|
  artifact = File.join(dir, 'candidate.aab')
  Zip::File.open(artifact, create: true) do |zip|
    zip.get_output_stream(Readiness::AndroidArtifact::R8_MAPPING) { |io| io.write('mapping') }
    zip.get_output_stream('base/lib/arm64-v8a/libfixture.so') { |io| io.write('fixture') }
  end
  manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" ' \
             "package=\"#{APP}\" android:versionName=\"1.0\" android:versionCode=\"14\">" \
             '<uses-sdk android:minSdkVersion="31" android:targetSdkVersion="36"/>' \
             '<uses-permission android:name="android.permission.INTERNET"/>' \
             '<application android:debuggable="false"/></manifest>'
  Readiness.define_singleton_method(:command) do |*args|
    if args.include?('manifest')
      raise Errno::ENOENT if mode == :missing_tool
      next manifest.sub('<application', '<uses-permission-sdk-23 android:name="android.permission.CAMERA"/><application') if mode == :sdk23_permission
      next manifest unless mode == :bad_manifest

      manifest.sub('debuggable="false"', 'debuggable="true"')
              .sub('<application', '<uses-permission android:name="android.permission.CAMERA"/><application')
    elsif args.include?('validate')
      raise Readiness::CommandError, 'bundletool failed' if mode == :invalid_bundle

      ''
    else
      raise Readiness::CommandError, 'jarsigner failed' if mode == :bad_signature

      mode == :unsigned ? 'jar verified. This jar contains unsigned entries' : 'jar verified.'
    end
  end
  expected = { identifier: APP, permissions: ['android.permission.INTERNET'], minified: true }
  inspect = lambda do |path, expectation|
    report = Readiness::Report.new('android', path, dir)
    Readiness.android_artifact(report, path, expectation)
    report.data
  end
  %i[good bad_manifest sdk23_permission invalid_bundle bad_signature unsigned missing_tool].each do |scenario|
    mode = scenario
    results["android_#{scenario}"] = inspect.call(artifact, expected)
  end
  mode = :good
  empty = File.join(dir, 'empty.aab')
  Zip::File.open(empty, create: true) do |zip|
    zip.get_output_stream('base/manifest/AndroidManifest.xml') { |io| io.write('fixture') }
  end
  results[:android_no_mapping] = inspect.call(empty, expected)
  results[:android_unminified] = inspect.call(empty, expected.merge(minified: false))
  results[:android_other_identifier] = inspect.call(artifact, expected.merge(identifier: 'com.example.other'))
  notifications = %w[android.permission.INTERNET android.permission.POST_NOTIFICATIONS]
  results[:android_missing_permission] = inspect.call(artifact, expected.merge(permissions: notifications))

  service = Object.new
  track_number = '14'
  release_status = 'completed'
  bundle_hash = Digest::SHA256.file(artifact).hexdigest
  listing_present = true
  screenshots = ['image']
  events = []
  packages = []
  service.define_singleton_method(:insert_edit) do |package, *|
    packages << package
    events << 'insert'
    OpenStruct.new(id: 'temporary')
  end
  service.define_singleton_method(:delete_edit) { |*| events << 'delete' }
  service.define_singleton_method(:get_edit_track) do |*|
    OpenStruct.new(releases: [OpenStruct.new(version_codes: [track_number], status: release_status)])
  end
  service.define_singleton_method(:list_edit_bundles) do |*|
    OpenStruct.new(bundles: [OpenStruct.new(version_code: 14, sha256: bundle_hash)])
  end
  service.define_singleton_method(:list_edit_listings) do |*|
    listings = %w[en-US de-DE].map do |locale|
      OpenStruct.new(language: locale, title: 'Title', short_description: 'Short', full_description: 'Full')
    end
    OpenStruct.new(listings: listing_present ? listings : [])
  end
  service.define_singleton_method(:list_edit_images) do |_package, _edit, locale, _type|
    raise 'Only the screenshot locale has screenshots' unless locale == 'en-US'

    OpenStruct.new(images: screenshots)
  end
  audit = lambda do
    report = Readiness::Report.new('android', artifact, dir)
    report.data[:artifact][:build_number] = '14'
    Readiness.android_store_records(report, service: service, package: APP, listing: LISTING, track: 'internal')
    report.data
  end
  results[:play_good] = audit.call
  track_number = '13'
  results[:play_wrong_code] = audit.call
  track_number = '14'
  release_status = 'draft'
  results[:play_draft] = audit.call
  release_status = 'completed'
  bundle_hash = 'mismatching hash'
  listing_present = false
  results[:play_bad_listing_hash] = audit.call
  listing_present = true
  screenshots = []
  results[:play_no_screenshots] = audit.call
  results[:play_audit_cleanup] = events
  results[:play_packages] = packages.uniq
  report = Readiness::Report.new('android', artifact, dir)
  Readiness.android_store(report, package: APP, key_path: 'must-not-open', listing: LISTING)
  results[:play_unknown_code] = report.data
end
Readiness.define_singleton_method(:command, original_command)

puts JSON.generate(results)
`;

async function runReadinessScript() {
  const child = Bun.spawn(["bundle", "exec", "ruby", "-e", script, root], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Readiness library fixtures failed: ${stderr}`);
  }
  return JSON.parse(stdout);
}

const result = await runReadinessScript();

interface Report {
  checks: { id: string; status: string }[];
}

const status = (report: Report, id: string) =>
  report.checks.find((check) => check.id === id)?.status;

describe("artifact-bound readiness reports", () => {
  test("does not infer provenance from the current checkout", () => {
    expect(result.missing_receipt).toBe("incomplete");
    expect(result.good_receipt).toBe("ready_within_tested_scope");
    expect(result.source_changed).toBe("failed");
    expect(result.tampered).toBe("not_ready");
    expect(result.bad_receipt).toBe("incomplete");
    expect(result.missing_artifact).toBe("not_ready");
  });

  test("keeps manual coverage unknown and private diagnostics redacted", () => {
    expect(result.manual_remains_unknown).toBe("incomplete");
    expect(result.written_result).toBe("incomplete");
    expect(result.private_mode).toBe(0o600);
    expect(result.redacted).not.toContain("secret-contact");
    expect(result.redacted).not.toContain("token-secret");
  });

  test("leaves the source unverified without git", () => {
    expect(result.missing_git.result).toBe("incomplete");
    expect(status(result.missing_git, "source.checkout")).toBe("unverified");
    expect(status(result.missing_git, "artifact.current_commit")).toBe(
      "unverified",
    );
  });

  test("bounds the processing wait and stops on a rejected build", () => {
    expect(result.timeout).toEqual([20, 3, "PROCESSING"]);
    expect(result.terminal).toEqual([15, 2, "INVALID"]);
  });

  test("extracts into the temporary directory and rejects traversal", () => {
    expect(result.unpacked).toBe("fixture");
    expect(result.unsafe_rejected).toBe(true);
  });
});

describe("iOS artifact verdicts", () => {
  const ids = ["com.example.app", "com.example.app.widget"];

  test("verifies each packaged target and rejects invalid distribution evidence", () => {
    expect(result.ios_good.artifact.build_number).toBe("12");
    expect(status(result.ios_good, "artifact.identifier")).toBe("verified");
    expect(status(result.ios_good, "artifact.targets")).toBe("verified");
    for (const id of ids) {
      for (const check of [
        "signature",
        "app_group",
        "distribution",
        "privacy",
      ]) {
        expect(status(result.ios_good, `${check}.${id}`)).toBe("verified");
      }
      for (const mode of ["development", "ad_hoc", "enterprise", "expired"]) {
        expect(status(result[`ios_${mode}`], `distribution.${id}`)).toBe(
          "failed",
        );
      }
      expect(status(result.ios_debuggable, `signature.${id}`)).toBe("failed");
      expect(status(result.ios_missing_group, `app_group.${id}`)).toBe(
        "failed",
      );
      expect(status(result.ios_missing_profile, `distribution.${id}`)).toBe(
        "failed",
      );
      expect(status(result.ios_bad_signature, `signature.${id}`)).toBe(
        "failed",
      );
      expect(status(result.ios_missing_codesign, `signature.${id}`)).toBe(
        "unverified",
      );
    }
  });

  test("requires each privacy manifest to make the expected declarations", () => {
    for (const mode of [
      "tracking",
      "undeclared_tracking",
      "undeclared_collection",
      "other_collection",
      "missing_purposes",
      "other_purpose",
      "unlinked",
      "undeclared_linked",
      "tracked_type",
      "duplicate_type",
      "missing_reason",
      "missing_privacy",
    ]) {
      for (const id of ids) {
        expect(status(result[`ios_${mode}`], `privacy.${id}`)).toBe("failed");
      }
    }
  });

  test("checks app groups only where expected and rejects unexpected targets", () => {
    expect(status(result.ios_app_only, "artifact.targets")).toBe("verified");
    expect(status(result.ios_app_only, "app_group.com.example.app")).toBe(
      "verified",
    );
    expect(status(result.ios_app_only, "privacy.com.example.app")).toBe(
      "verified",
    );
    expect(status(result.ios_unexpected_target, "artifact.targets")).toBe(
      "failed",
    );
    // An app expected to have no app groups must not gain one.
    expect(
      status(result.ios_unexpected_target, "app_group.com.example.app"),
    ).toBe("failed");
  });
});

describe("App Store Connect verdicts", () => {
  test("requires the selected exact build and completed iPhone and iPad screenshots", () => {
    expect(result.store_app).toBe("com.example.app");
    // The selected-build check reads the version's build relationship.
    expect(result.store_includes).toBe("build");
    // A rejected candidate is found and fails instead of looking absent.
    expect(result.build_states).toBe("PROCESSING,FAILED,INVALID,VALID");
    expect(status(result.store_rejected, "store.processed_build")).toBe(
      "failed",
    );
    for (const id of [
      "store.processed_build",
      "store.selected_build",
      "store.review_contact",
      "store.review_notes",
      "store.listing.en-US",
      "store.listing.de-DE",
      "store.screenshots.en-US",
    ]) {
      expect(status(result.store_good, id)).toBe("verified");
    }
    expect(
      status(result.store_good, "store.screenshots.de-DE"),
    ).toBeUndefined();
    expect(status(result.store_wrong_selected, "store.selected_build")).toBe(
      "failed",
    );
    expect(status(result.store_reserved_phone, "store.screenshots.en-US")).toBe(
      "failed",
    );
    expect(status(result.store_missing_ipad, "store.screenshots.en-US")).toBe(
      "failed",
    );
    expect(JSON.stringify(result.store_good)).not.toContain(
      "private@example.test",
    );
  });

  test("never substitutes another build or treats missing review details as complete", () => {
    expect(status(result.store_stale_build, "store.processed_build")).toBe(
      "unverified",
    );
    expect(status(result.store_stale_build, "store.selected_build")).toBe(
      "failed",
    );
    expect(status(result.store_no_review, "store.review_contact")).toBe(
      "failed",
    );
    expect(status(result.store_no_review, "store.review_notes")).toBe("failed");
    expect(status(result.store_no_review, "store.screenshots.en-US")).toBe(
      "verified",
    );
    expect(status(result.store_blank_contact, "store.review_contact")).toBe(
      "failed",
    );
    expect(status(result.store_no_version, "store.version")).toBe("failed");
    expect(status(result.store_unknown_candidate, "store.candidate")).toBe(
      "unverified",
    );
  });
});

describe("Android artifact verdicts", () => {
  test("checks manifest, signature, mapping, and native inventory", () => {
    for (const id of [
      "artifact.identifier",
      "artifact.release",
      "artifact.permissions",
      "artifact.bundle_structure",
      "artifact.signature",
      "artifact.r8_mapping",
    ]) {
      expect(status(result.android_good, id)).toBe("verified");
    }
    expect(result.android_good.artifact.build_number).toBe("14");
    expect(result.android_good.artifact.native_libraries).toEqual([
      "base/lib/arm64-v8a/libfixture.so",
    ]);
    expect(status(result.android_good, "artifact.native_page_size")).toBe(
      "unverified",
    );
    expect(status(result.android_bad_manifest, "artifact.release")).toBe(
      "failed",
    );
    expect(status(result.android_bad_manifest, "artifact.permissions")).toBe(
      "failed",
    );
    expect(
      status(result.android_sdk23_permission, "artifact.permissions"),
    ).toBe("failed");
    expect(result.android_sdk23_permission.artifact.permissions).toEqual([
      "android.permission.INTERNET",
      "android.permission.CAMERA",
    ]);
    expect(
      status(result.android_missing_permission, "artifact.permissions"),
    ).toBe("failed");
    expect(status(result.android_other_identifier, "artifact.identifier")).toBe(
      "failed",
    );
    expect(status(result.android_no_mapping, "artifact.r8_mapping")).toBe(
      "failed",
    );
    expect(status(result.android_unminified, "artifact.r8_mapping")).toBe(
      "not_applicable",
    );
    expect(status(result.android_no_mapping, "artifact.native_page_size")).toBe(
      "not_applicable",
    );
  });

  test("distinguishes rejected artifacts from missing tools and continues independent checks", () => {
    expect(
      status(result.android_invalid_bundle, "artifact.bundle_structure"),
    ).toBe("failed");
    expect(status(result.android_invalid_bundle, "artifact.signature")).toBe(
      "verified",
    );
    expect(status(result.android_bad_signature, "artifact.signature")).toBe(
      "failed",
    );
    expect(status(result.android_bad_signature, "artifact.r8_mapping")).toBe(
      "verified",
    );
    expect(status(result.android_unsigned, "artifact.signature")).toBe(
      "failed",
    );
    expect(status(result.android_missing_tool, "artifact.android")).toBe(
      "unverified",
    );
    expect(status(result.android_missing_tool, "artifact.signature")).toBe(
      "verified",
    );
    expect(status(result.android_missing_tool, "artifact.r8_mapping")).toBe(
      "verified",
    );
  });
});

describe("Google Play verdicts", () => {
  test("always deletes the temporary edit, including after a failed read", () => {
    expect(result.play_cleanup).toEqual(["insert", "read", "delete"]);
  });

  test("requires the exact active candidate, bytes, listings, and screenshots", () => {
    for (const id of [
      "store.track_candidate",
      "store.bundle_hash",
      "store.listing.en-US",
      "store.listing.de-DE",
      "store.screenshots.en-US",
    ]) {
      expect(status(result.play_good, id)).toBe("verified");
    }
    expect(status(result.play_good, "store.screenshots.de-DE")).toBeUndefined();
    expect(status(result.play_wrong_code, "store.track_candidate")).toBe(
      "failed",
    );
    expect(status(result.play_draft, "store.track_candidate")).toBe("failed");
    expect(status(result.play_bad_listing_hash, "store.bundle_hash")).toBe(
      "failed",
    );
    expect(status(result.play_bad_listing_hash, "store.listing.en-US")).toBe(
      "failed",
    );
    expect(
      status(result.play_bad_listing_hash, "store.screenshots.en-US"),
    ).toBe("failed");
    expect(status(result.play_no_screenshots, "store.screenshots.en-US")).toBe(
      "failed",
    );
    expect(result.play_audit_cleanup).toEqual(
      Array.from({ length: 5 }, () => ["insert", "delete"]).flat(),
    );
    expect(result.play_packages).toEqual(["com.example.app"]);
  });

  test("does not contact Play without the artifact's version code", () => {
    expect(status(result.play_unknown_code, "store.candidate")).toBe(
      "unverified",
    );
    expect(
      status(result.play_unknown_code, "store.track_candidate"),
    ).toBeUndefined();
  });
});
