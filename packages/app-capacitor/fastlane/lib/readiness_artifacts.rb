# frozen_string_literal: true

require_relative 'readiness'
require 'tmpdir'

# Artifact inspection: what the IPA or AAB itself contains and how it's signed.
module Readiness
  # Reject traversal and symlinks before extracting an IPA for codesign inspection.
  def self.unpack(artifact, destination)
    require 'zip'
    Zip::File.open(artifact) do |zip|
      zip.each do |entry|
        path = File.expand_path(entry.name, destination)
        raise 'Unsafe archive entry' unless path.start_with?("#{destination}/") && !entry.symlink?

        FileUtils.mkdir_p(File.dirname(path))
        entry.extract(entry.name, destination_directory: destination)
      end
    end
  end

  def self.plist(path)
    require 'cfpropertylist'
    CFPropertyList.native_types(CFPropertyList::List.new(file: path).value)
  end

  # expected[:targets] maps each packaged bundle identifier, the app's first, to the
  # app groups it must be entitled to. expected[:privacy] is what every packaged
  # privacy manifest must declare: tracking:, collected_data_types: (the
  # NSPrivacyCollectedDataType values), and accessed_api_reasons: (category => reasons).
  def self.ios_artifact(report, artifact, expected)
    return unless File.file?(artifact)

    report.attempt('artifact.ios') do
      Dir.mktmpdir('readiness-') do |dir|
        unpack(artifact, dir)
        apps = Dir.glob(File.join(dir, 'Payload', '*.app'))
        raise 'Expected one application' unless apps.length == 1

        IosArtifact.new(report, dir, expected).inspect_app(apps.first)
      end
    end
  end

  # expected gives the application identifier:, its merged manifest's complete
  # permissions:, and whether release builds are minified: by R8.
  def self.android_artifact(report, artifact, expected, bundletool: nil)
    return unless File.file?(artifact)

    android = AndroidArtifact.new(report, artifact, expected)
    report.attempt('artifact.android') { android.inspect_manifest(bundletool) }
    report.attempt('artifact.signature', verification: true) { android.inspect_signature }
    report.add('artifact.upload_key_identity', 'unverified',
               'Compare signer certificate with the expected Play upload certificate.')
    report.attempt('artifact.contents') { android.inspect_contents }
  end

  # Checks an unpacked IPA's app and each of its extensions.
  class IosArtifact
    def initialize(report, dir, expected)
      @report = report
      @dir = dir
      @targets = expected.fetch(:targets)
      @privacy = expected.fetch(:privacy)
    end

    def inspect_app(app)
      info = Readiness.plist(File.join(app, 'Info.plist'))
      record_versions(info)
      identifier = @targets.keys.first
      @report.check('artifact.identifier', info['CFBundleIdentifier'] == identifier, "Expected #{identifier}.")
      packaged_targets(app).each { |target, id| inspect_target(target, id) }
    end

    private

    # The app and its extensions, each with its bundle identifier.
    def packaged_targets(app)
      targets = ([app] + Dir.glob(File.join(app, 'PlugIns', '*.appex'))).to_h do |target|
        [target, Readiness.plist(File.join(target, 'Info.plist')).fetch('CFBundleIdentifier')]
      end
      @report.check('artifact.targets', targets.values.sort == @targets.keys.sort,
                    "Expected exactly these packaged targets: #{@targets.keys.join(', ')}.")
      targets
    end

    def record_versions(info)
      artifact = @report.data[:artifact]
      artifact[:version] = info.fetch('CFBundleShortVersionString')
      artifact[:build_number] = info.fetch('CFBundleVersion')
      artifact[:sdk] = info['DTSDKName']
      artifact[:minimum_os] = info['MinimumOSVersion']
    end

    def inspect_target(target, id)
      @report.attempt("signature.#{id}", verification: true) { inspect_signature(target, id) }
      @report.attempt("distribution.#{id}") { inspect_distribution(target, id) }
      @report.attempt("privacy.#{id}") { inspect_privacy(target, id) }
    end

    def inspect_signature(target, id)
      Readiness.command('codesign', '--verify', '--deep', '--strict', target)
      values = write_plist('entitlements.plist',
                           Readiness.command('codesign', '--display', '--entitlements', '-', '--xml', target))
      signed = values['get-task-allow'] != true && values.fetch('application-identifier', '').end_with?(".#{id}")
      @report.check("signature.#{id}", signed, 'Signature verifies and disallows debugging.')
      check_app_groups(values, id)
    end

    def check_app_groups(values, id)
      expected = @targets.fetch(id, [])
      return if expected.empty?

      groups = values.fetch('com.apple.security.application-groups', [])
      @report.check("app_group.#{id}", (expected - groups).empty?,
                    "Expected app group entitlements: #{expected.join(', ')}.")
    end

    def inspect_distribution(target, id)
      profile = File.join(target, 'embedded.mobileprovision')
      unless File.file?(profile)
        return @report.check("distribution.#{id}", false, 'Packaged target is missing its distribution profile.')
      end

      values = write_plist('profile.plist', Readiness.command('security', 'cms', '-D', '-i', profile))
      @report.check("distribution.#{id}", app_store_profile?(values),
                    'Embedded profile must be for App Store distribution, not development/ad hoc/enterprise.')
    end

    def app_store_profile?(values)
      !values.key?('ProvisionedDevices') && values['ProvisionsAllDevices'] != true &&
        Time.parse(values.fetch('ExpirationDate').to_s) > Time.now
    end

    def inspect_privacy(target, id)
      path = File.join(target, 'PrivacyInfo.xcprivacy')
      unless File.file?(path)
        return @report.check("privacy.#{id}", false, 'Packaged target is missing its privacy manifest.')
      end

      @report.check("privacy.#{id}", declared_privacy?(Readiness.plist(path)),
                    'Packaged privacy manifest must make the reviewed tracking, collected data type, and ' \
                    'required-reason API declarations.')
    end

    # Tracking and the collected data types must be declared and match exactly;
    # each expected API category must give at least its expected reasons.
    def declared_privacy?(privacy)
      collected = privacy['NSPrivacyCollectedDataTypes']&.map { |type| type['NSPrivacyCollectedDataType'] }
      privacy['NSPrivacyTracking'] == @privacy.fetch(:tracking) &&
        collected&.sort == @privacy.fetch(:collected_data_types).sort &&
        @privacy.fetch(:accessed_api_reasons).all? do |category, reasons|
          (reasons - accessed_api_reasons(privacy, category)).empty?
        end
    end

    def accessed_api_reasons(privacy, category)
      privacy.fetch('NSPrivacyAccessedAPITypes', [])
             .select { |api| api['NSPrivacyAccessedAPIType'] == category }
             .flat_map { |api| api.fetch('NSPrivacyAccessedAPITypeReasons', []) }
    end

    # Saves a tool's plist output in the unpacked folder and parses it.
    def write_plist(name, contents)
      path = File.join(@dir, name)
      File.write(path, contents)
      Readiness.plist(path)
    end
  end

  # Checks an AAB's manifest (through bundletool), signature, and contents.
  class AndroidArtifact
    R8_MAPPING = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map'

    def initialize(report, artifact, expected)
      @report = report
      @artifact = artifact
      @identifier = expected.fetch(:identifier)
      @permissions = expected.fetch(:permissions)
      @minified = expected.fetch(:minified)
    end

    def inspect_manifest(bundletool)
      require 'rexml/document'
      require 'zip'
      tool = bundletool ? ['java', '-jar', File.expand_path(bundletool)] : ['bundletool']
      manifest = REXML::Document.new(
        Readiness.command(*tool, 'dump', 'manifest', "--bundle=#{@artifact}", '--module=base')
      ).root
      record_versions(manifest)
      check_manifest(manifest)
      @report.attempt('artifact.bundle_structure', verification: true) { validate_bundle(tool) }
    end

    def inspect_signature
      signature = Readiness.command('jarsigner', '-verify', @artifact)
      verified = signature.include?('jar verified.') && !signature.include?('unsigned entries')
      @report.check('artifact.signature', verified,
                    'AAB JAR signature must verify with no unsigned entries. ' \
                    'This does not establish the Play upload-key identity.')
    end

    def inspect_contents
      require 'zip'
      Zip::File.open(@artifact) do |zip|
        check_mapping(zip)
        record_native_libraries(zip.entries.map(&:name).grep(%r{^[^/]+/lib/.*\.so$}))
      end
    end

    private

    def validate_bundle(tool)
      Readiness.command(*tool, 'validate', "--bundle=#{@artifact}")
      @report.add('artifact.bundle_structure', 'verified', 'bundletool validation passed.')
    end

    def check_mapping(zip)
      return @report.add('artifact.r8_mapping', 'not_applicable', 'Release builds are not minified.') unless @minified

      @report.check('artifact.r8_mapping', !zip.find_entry(R8_MAPPING).nil?,
                    'Expected the release obfuscation mapping in the AAB.')
    end

    def record_native_libraries(native)
      @report.data[:artifact][:native_libraries] = native
      if native.empty?
        @report.add('artifact.native_page_size', 'not_applicable', 'No native libraries.')
      else
        @report.add('artifact.native_page_size', 'unverified',
                    'Verify ELF and generated APK 16KB alignment for the listed native libraries.')
      end
    end

    def record_versions(manifest)
      sdk = manifest.elements['uses-sdk']&.attributes
      @report.data[:artifact].merge!(
        version: manifest.attributes['android:versionName'], build_number: manifest.attributes['android:versionCode'],
        target_sdk: sdk&.[]('android:targetSdkVersion'), minimum_sdk: sdk&.[]('android:minSdkVersion')
      )
    end

    def check_manifest(manifest)
      app = manifest.elements['application']
      @report.check('artifact.identifier', manifest.attributes['package'] == @identifier, "Expected #{@identifier}.")
      @report.check('artifact.release', app && app.attributes['android:debuggable'] != 'true',
                    'Release manifest must disallow debugging.')
      check_permissions(manifest)
    end

    def check_permissions(manifest)
      permissions = manifest.get_elements('uses-permission').map { |permission| permission.attributes['android:name'] }
      @report.data[:artifact][:permissions] = permissions
      @report.check('artifact.permissions', permissions.sort == @permissions.sort,
                    'Merged manifest permissions must match the reviewed list; review the Play declarations ' \
                    'and Data safety answers before changing it.')
    end
  end
end
