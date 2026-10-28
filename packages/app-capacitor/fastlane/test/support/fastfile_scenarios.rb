# frozen_string_literal: true

# Runs scenarios against the real Fastfile. Loading fastlane takes about a
# second, so the Fastfile loads once and each scenario runs in a forked child,
# which keeps its stubs and environment changes to itself.
#
#   bundle exec ruby fastlane/test/support/fastfile_scenarios.rb <scenario>...
#
# Run it from packages/app-capacitor with NATIVE_RELEASE_TIER set. Scenarios
# live in scenarios/*.rb, receive the Fastfile and the FASTFILE_SCENARIO_DIR
# fixture folder, and return a JSON value. The last line printed is
# {scenario => {"value" => result} or {"error" => message}}.

require 'json'

# The registry scenarios/*.rb add to with FastfileScenarios.define.
module FastfileScenarios
  @scenarios = {}

  def self.define(name, &block)
    @scenarios[name.to_s] = block
  end

  def self.run(fastfile, names, dir)
    names.to_h do |name|
      [name, run_forked { @scenarios.fetch(name) { raise "Unknown scenario #{name}" }.call(fastfile, dir) }]
    end
  end

  def self.run_forked(&)
    # UTF-8 whatever the caller's locale, as JSON is.
    reader, writer = IO.pipe(Encoding::UTF_8)
    $stdout.flush
    pid = fork do
      reader.close
      writer.write(outcome_json(&))
      writer.close
      # Skip at_exit hooks and the output buffers the parent still owns.
      exit!(0)
    end
    writer.close
    output = reader.read
    _, status = Process.wait2(pid)
    output.empty? ? { 'error' => "The scenario ended without a result (#{status})." } : JSON.parse(output)
  end

  def self.outcome_json
    JSON.generate('value' => yield)
  rescue StandardError, ScriptError => e
    JSON.generate('error' => "#{e.class}: #{e.message}\n#{Array(e.backtrace).first(8).join("\n")}")
  end
end

Dir[File.join(__dir__, 'scenarios', '*.rb')].each { |path| require path }

if $PROGRAM_NAME == __FILE__
  require 'fastlane'

  Fastlane.load_actions
  fastfile = Fastlane::FastFile.new('fastlane/Fastfile')
  results = FastfileScenarios.run(fastfile, ARGV, ENV.fetch('FASTFILE_SCENARIO_DIR'))
  puts JSON.generate(results)
end
