# frozen_string_literal: true

require 'fastlane_core'

# Reads a lane option, falling back to the first environment variable in
# env_names that is set, then to default_value.
def lane_option(options, key, env_names, default_value = nil)
  value = options[key]
  Array(env_names).each do |env_name|
    break unless value.nil? || value.to_s.empty?

    value = ENV.fetch(env_name, nil)
  end
  return default_value if value.nil? || value.to_s.empty?

  value
end

def lane_boolean_option(options, key, env_names, default_value)
  value = lane_option(options, key, env_names, default_value)
  return value if [true, false].include?(value)

  case value.to_s.strip.downcase
  when '1', 'true', 'yes', 'y'
    true
  when '0', 'false', 'no', 'n'
    false
  else
    FastlaneCore::UI.user_error!("Invalid boolean for #{key}: #{value}. Expected true or false.")
  end
end
