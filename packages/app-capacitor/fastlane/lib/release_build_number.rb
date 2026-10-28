# frozen_string_literal: true

require_relative 'lane_options'
require_relative 'merged_release_pr'

# Chooses a store release's build number the same way for Google Play and
# TestFlight:
#
# 1. build_number:<n>, or the platform's build-number environment names;
# 2. with next_<store>:true, the store's latest build number plus one;
# 3. otherwise the larger of the PR merged last on the release date and the
#    store's latest plus one. Without store credentials, or with the store's
#    guard skipped, the merged PR alone decides.
#
# A Store adapter supplies the platform's Names and the store lookups. The
# result's store_build_number is the latest number the store reported, when it
# was read.
class ReleaseBuildNumber
  # The platform's option and environment names and its log wording. The next
  # option's environment name is <env_prefix>_RELEASE_<NEXT_OPTION>; the skip
  # option's is its upcased name.
  Names = Data.define(
    :platform, :env_prefix, :store, :credentials, :guard, :next_option, :skip_option, :build_number_env_names
  )

  # configured: whether the store's credentials are present.
  # latest: the store's latest build number, or nil.
  # scope: what the lookup covered, for the log.
  Store = Data.define(:names, :configured, :latest, :scope)

  def self.resolve(store, options)
    new(store, options).resolve
  end

  def initialize(store, options)
    @store = store
    @names = store.names
    @options = options
  end

  def resolve
    explicit = explicit_build_number
    next_requested = next_build_number_requested?
    if explicit && next_requested
      FastlaneCore::UI.user_error!("Use either build_number or #{@names.next_option}:true, not both.")
    end
    return result(explicit) if explicit
    return next_store_build_number if next_requested

    automatic_build_number
  end

  private

  def result(build_number, merged_pr_number: nil, store_build_number: nil)
    { build_number: build_number, merged_pr_number: merged_pr_number, store_build_number: store_build_number }
  end

  def explicit_build_number
    option_env_name, fallback_env_name = @names.build_number_env_names
    value = lane_option(@options, :build_number, option_env_name) || env_option(fallback_env_name)
    value && positive_release_integer(value, "#{@names.platform} release build number")
  end

  def next_build_number_requested?
    env_name = "#{@names.env_prefix}_RELEASE_#{@names.next_option.to_s.upcase}"
    lane_boolean_option(@options, @names.next_option, env_name, false)
  end

  def guard_skipped?
    lane_boolean_option(@options, @names.skip_option, @names.skip_option.to_s.upcase, false)
  end

  def latest_store_build_number
    latest = @store.latest.call
    FastlaneCore::UI.message("#{@names.store} latest build number: #{latest || 'none'} (#{@store.scope})")
    latest
  end

  def require_store_lookup!
    FastlaneCore::UI.user_error!("#{@names.next_option} requires #{@names.store} version lookup.") if guard_skipped?
    FastlaneCore::UI.user_error!("#{@names.next_option} requires #{@names.credentials}.") unless @store.configured.call
  end

  def next_store_build_number
    require_store_lookup!
    latest = begin
      latest_store_build_number
    rescue StandardError => e
      FastlaneCore::UI.user_error!("Failed to resolve next #{@names.store} build number: #{e.message}")
    end
    build_number = (latest || 0) + 1
    FastlaneCore::UI.message("Using next #{@names.store} build number: #{build_number}")
    result(build_number, store_build_number: latest)
  end

  def store_guard_available?
    if guard_skipped?
      FastlaneCore::UI.important("Skipping #{@names.guard} as requested.")
      false
    elsif @store.configured.call
      true
    else
      FastlaneCore::UI.important("#{@names.credentials} not found; using merged PR number without #{@names.guard}.")
      false
    end
  end

  def guarded_store_build_number
    store_guard_available? ? latest_store_build_number : nil
  rescue StandardError => e
    FastlaneCore::UI.user_error!("Failed to verify #{@names.store} build number: #{e.message}")
  end

  def automatic_build_number
    merged_pr_number = merged_release_pr_number(@options, @names.env_prefix)
    latest = guarded_store_build_number
    build_number = [merged_pr_number, latest && (latest + 1)].compact.max
    result(build_number, merged_pr_number: merged_pr_number, store_build_number: latest)
  end
end
