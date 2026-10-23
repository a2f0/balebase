# frozen_string_literal: true

require 'digest'
require 'fileutils'
require 'json'
require 'open3'
require 'time'

# Evidence is tied to artifact bytes, never inferred from whichever checkout happens
# to be open during an audit. Reports intentionally omit store contacts and raw errors.
# balebase and nc keep identical copies of the readiness libraries; each repository's
# lanes pass in what its apps are expected to contain (see docs/readiness.md).
module Readiness
  class CommandError < StandardError; end

  def self.command(*args)
    out, _err, status = Open3.capture3({ 'LC_ALL' => 'C' }, *args)
    raise CommandError, "#{File.basename(args.first)} failed" unless status.success?

    out
  end

  def self.source(root)
    { 'commit' => command('git', '-C', root, 'rev-parse', 'HEAD').strip,
      'dirty' => !command('git', '-C', root, 'status', '--porcelain').strip.empty? }
  end

  def self.record_build(artifact, source, root: nil)
    source = source.merge('dirty' => true) if root && source != self.source(root)
    data = { 'schema_version' => 1, 'sha256' => Digest::SHA256.file(artifact).hexdigest,
             'source' => source, 'built_at' => Time.now.utc.iso8601 }
    File.write("#{artifact}.build.json", "#{JSON.pretty_generate(data)}\n", perm: 0o600)
  end

  # A platform's readiness checks for one artifact, written as a private JSON report.
  class Report
    MISSING_RECEIPT = 'No build receipt. Rebuild with the release lane to identify the source commit.'
    COMMIT = /\A[0-9a-f]{40}\z/

    attr_reader :data

    def initialize(platform, artifact, root)
      @data = { schema_version: 1, platform: platform, audited_at: Time.now.utc.iso8601,
                checkout: nil, artifact: { name: File.basename(artifact) }, checks: [] }
      attempt('source.checkout') { @data[:checkout] = Readiness.source(root) }
      if File.file?(artifact)
        @data[:artifact][:sha256] = Digest::SHA256.file(artifact).hexdigest
        check('artifact.exists', true, 'Artifact is present.')
        provenance(artifact)
      else
        check('artifact.exists', false, 'Build the release artifact or pass artifact:/absolute/path.')
      end
    end

    def add(id, status, detail)
      @data[:checks] << { id: id, status: status, detail: detail }
    end

    def check(id, passed, detail)
      add(id, passed ? 'verified' : 'failed', detail)
    end

    # Authentication/network/tool errors must leave a report, never a false pass.
    def attempt(id, verification: false)
      yield
    rescue CommandError => e
      add(id, verification ? 'failed' : 'unverified', "#{e.message}; rerun the named tool locally for diagnostics.")
    rescue StandardError => e
      add(id, 'unverified',
          "Could not complete check (#{e.class.name}); check credentials, tools, and connectivity locally.")
    end

    def result
      statuses = @data[:checks].map { |check| check[:status] }
      return 'not_ready' if statuses.include?('failed')

      statuses.include?('unverified') ? 'incomplete' : 'ready_within_tested_scope'
    end

    def write(path)
      @data[:result] = result
      FileUtils.mkdir_p(File.dirname(path), mode: 0o700)
      File.write(path, "#{JSON.pretty_generate(@data)}\n", perm: 0o600)
      File.chmod(0o600, path)
    end

    private

    def provenance(artifact)
      receipt = "#{artifact}.build.json"
      return add('artifact.provenance', 'unverified', MISSING_RECEIPT) unless File.file?(receipt)

      attempt('artifact.provenance') do
        build = JSON.parse(File.read(receipt))
        valid = valid_receipt?(build)
        check('artifact.provenance', valid, 'Build receipt must match the artifact SHA-256 and identify its source.')
        build_source(build) if valid
      end
    end

    def valid_receipt?(build)
      build['schema_version'] == 1 && build['sha256'] == @data[:artifact][:sha256] &&
        build.dig('source', 'commit').to_s.match?(COMMIT) && [true, false].include?(build.dig('source', 'dirty'))
    end

    def build_source(build)
      source = build['source']
      @data[:artifact][:build] = { 'source' => source.slice('commit', 'dirty'), 'built_at' => build['built_at'] }
      check('artifact.clean_source', !source['dirty'], 'A release candidate must be built from a clean checkout.')
      check_current_commit(source)
    end

    def check_current_commit(source)
      checkout = @data[:checkout]
      if checkout
        check('artifact.current_commit', source['commit'] == checkout['commit'] && !checkout['dirty'],
              'Artifact source must match the audited clean checkout.')
      else
        add('artifact.current_commit', 'unverified',
            'Checkout source could not be read; install git and run from the repository checkout.')
      end
    end
  end

  MANUAL_CHECKS = {
    'manual.accessibility_devices' =>
      'Run VoiceOver/TalkBack sessions and physical-device tests of the system integrations, interruptions, ' \
      'and upgrade path against this candidate.',
    'console.declarations' =>
      'Confirm privacy/Data safety, ratings, agreements, pricing, availability, export/trader declarations, ' \
      'and Play production eligibility where applicable.',
    'policy.current_requirements' =>
      'Recheck current Apple SDK and Google target API requirements; artifact versions below are evidence, ' \
      'not a permanently current policy verdict.'
  }.freeze

  def self.manual_checks(report)
    MANUAL_CHECKS.each { |id, detail| report.add(id, 'unverified', detail) }
  end
end
