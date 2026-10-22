# frozen_string_literal: true

require 'dotenv'
require 'uri'

NATIVE_RELEASE_TARGETS = {
  'production' => {
    android_build_variant: 'release',
    api_host: 'api.balebase.com',
    app_host: 'app.balebase.com',
    app_identifier: 'com.balebase.app',
    capacitor_sync_script: 'cap:sync:release',
    ios_archive_name: 'Balebase.xcarchive',
    ios_configuration: 'Release',
    ios_ipa_name: 'Balebase.ipa',
    ios_output_directory: 'output',
    ios_scheme: 'App',
    secrets_tier: 'prod'
  }.freeze,
  'staging' => {
    android_build_variant: 'staging',
    api_host: 'api-staging.balebase.com',
    app_host: 'app-staging.balebase.com',
    app_identifier: 'com.balebase.staging.app',
    capacitor_sync_script: 'cap:sync:staging',
    ios_archive_name: 'Balebase-Staging.xcarchive',
    ios_configuration: 'Release-Staging',
    ios_ipa_name: 'Balebase-Staging.ipa',
    ios_output_directory: 'output/staging',
    ios_scheme: 'App-Staging',
    secrets_tier: 'staging'
  }.freeze
}.freeze

NATIVE_RELEASE_TIER = ENV.fetch('NATIVE_RELEASE_TIER', 'production').strip.downcase
NATIVE_RELEASE_TARGET = NATIVE_RELEASE_TARGETS.fetch(NATIVE_RELEASE_TIER) do
  raise "Unknown NATIVE_RELEASE_TIER=#{NATIVE_RELEASE_TIER.inspect}. Expected production or staging."
end
NATIVE_APP_IDENTIFIER = NATIVE_RELEASE_TARGET.fetch(:app_identifier)
NATIVE_CAPACITOR_SYNC_SCRIPT = NATIVE_RELEASE_TARGET.fetch(:capacitor_sync_script)
NATIVE_PACKAGE_DIR = File.expand_path('../..', __dir__)
NATIVE_REPO_ROOT = File.expand_path('../..', NATIVE_PACKAGE_DIR)

def native_release_tier_secrets_dir(tier)
  File.join(NATIVE_REPO_ROOT, '.secrets', NATIVE_RELEASE_TARGETS.fetch(tier).fetch(:secrets_tier))
end

# Each tier reads only its own `.secrets/<secrets tier>/` folder: signing keys,
# store credentials, `shared.env` (the values shared with other projects), and
# `app.env` (this project's). NATIVE_RELEASE_SECRETS_DIR names another folder
# instead; a relative path resolves against this package, as Gradle resolves it.
NATIVE_RELEASE_SECRETS_DIR_OVERRIDE = ENV.fetch('NATIVE_RELEASE_SECRETS_DIR', '').strip
NATIVE_SECRETS_DIR =
  if NATIVE_RELEASE_SECRETS_DIR_OVERRIDE.empty?
    native_release_tier_secrets_dir(NATIVE_RELEASE_TIER)
  else
    File.expand_path(NATIVE_RELEASE_SECRETS_DIR_OVERRIDE, NATIVE_PACKAGE_DIR)
  end
NATIVE_SHARED_ENV_PATH = File.join(NATIVE_SECRETS_DIR, 'shared.env')
NATIVE_APP_ENV_PATH = File.join(NATIVE_SECRETS_DIR, 'app.env')
# Store credentials and signing passwords, imported from either file; both also
# hold values a native release never uses (app.env the tier's server secrets).
# Values copied from root.env stay in shared.env until they are rotated into
# app.env.
NATIVE_STORE_ENV_NAMES = %w[
  ANDROID_KEYSTORE_KEY_PASS
  ANDROID_KEYSTORE_STORE_PASS
  APP_STORE_CONNECT_ISSUER_ID
  APP_STORE_CONNECT_KEY_ID
  MATCH_GIT_BASIC_AUTHORIZATION
  MATCH_GIT_URL
  MATCH_PASSWORD
  TEAM_ID
].freeze
# The release lanes choose the bundle's hosts; secrets files never set them.
NATIVE_RELEASE_SERVICE_URLS = {
  'VITE_API_URL' => :api_host,
  'VITE_APP_URL' => :app_host
}.freeze

def native_release_android_build_variant_task
  NATIVE_RELEASE_TARGET.fetch(:android_build_variant).capitalize
end

def native_release_android_artifact_relative_paths
  variant = NATIVE_RELEASE_TARGET.fetch(:android_build_variant)
  {
    aab: "bundle/#{variant}/app-#{variant}.aab",
    mapping: "mapping/#{variant}/mapping.txt",
    native_debug_symbols: "native-debug-symbols/#{variant}/native-debug-symbols.zip"
  }.freeze
end

def native_release_ios_archive_relative_path
  File.join(
    NATIVE_RELEASE_TARGET.fetch(:ios_output_directory),
    NATIVE_RELEASE_TARGET.fetch(:ios_archive_name)
  )
end

def parsed_native_release_env(path)
  File.file?(path) ? Dotenv.parse(path) : {}
end

def warn_ignored_native_vite_names(environment, source)
  ignored_names = environment.keys.select { |name| name.start_with?('VITE_') }
  return if ignored_names.empty?

  warn "Ignoring #{source} Vite settings for a native release: #{ignored_names.sort.join(', ')}"
end

def native_release_shared_environment
  shared_environment = parsed_native_release_env(NATIVE_SHARED_ENV_PATH)
  warn_ignored_native_vite_names(shared_environment, "#{NATIVE_RELEASE_TARGET.fetch(:secrets_tier)}/shared.env")
  shared_environment.slice(*NATIVE_STORE_ENV_NAMES)
end

def native_release_app_environment
  parsed_native_release_env(NATIVE_APP_ENV_PATH).slice(*NATIVE_STORE_ENV_NAMES)
end

# Parsing shared.env first lets app.env override it.
def native_release_file_environment
  native_release_shared_environment.merge(native_release_app_environment)
end

# Load release values while preserving every variable explicitly set by the
# caller, then default the bundle's hosts to the tier's own.
def load_native_release_secrets_env(validate_service_urls: true)
  process_environment = ENV.to_h

  native_release_file_environment.each do |name, value|
    ENV[name] = value unless process_environment.key?(name)
  end

  NATIVE_RELEASE_SERVICE_URLS.each do |env_name, host_key|
    ENV[env_name] = "https://#{NATIVE_RELEASE_TARGET.fetch(host_key)}" if ENV.fetch(env_name, '').strip.empty?
  end
  ensure_native_release_service_urls! if validate_service_urls
end

def native_release_parsed_url_problem(env_name, parsed_url)
  return 'must use the https scheme' unless parsed_url.scheme.to_s.downcase == 'https'

  host = parsed_url.host.to_s.downcase.delete_suffix('.')
  return 'must be an absolute URL with a host' if host.empty?

  expected_host = NATIVE_RELEASE_TARGET.fetch(NATIVE_RELEASE_SERVICE_URLS.fetch(env_name))
  return nil if host == expected_host

  "must use #{expected_host} for a #{NATIVE_RELEASE_TIER} release"
end

def native_release_service_url_problem(env_name, value)
  url = value.to_s.strip
  return nil if url.empty?

  native_release_parsed_url_problem(env_name, URI.parse(url))
rescue URI::InvalidURIError
  'must be an absolute URL with a host'
end

def ensure_native_release_service_urls!
  NATIVE_RELEASE_SERVICE_URLS.each_key do |env_name|
    problem = native_release_service_url_problem(env_name, ENV.fetch(env_name, nil))
    next if problem.nil?

    message = "#{env_name} #{problem}."
    defined?(UI) ? UI.user_error!(message) : raise(message)
  end
end
