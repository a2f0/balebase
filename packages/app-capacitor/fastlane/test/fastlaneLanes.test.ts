import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRubyBundle } from "./support/requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "../..");
const scratch = await mkdtemp(join(tmpdir(), "balebase-fastlane-lanes-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/**
 * Loads the real Fastfile, runs `body` against it as `fastfile`, and returns
 * the JSON the body prints last. Secrets resolve to the scratch folder.
 */
async function runLanes(body: string, env: Record<string, string> = {}) {
  await requireRubyBundle();
  const script = [
    'require "json"',
    'require "fastlane"',
    "Fastlane.load_actions",
    'fastfile = Fastlane::FastFile.new("fastlane/Fastfile")',
    body,
  ].join("\n");
  const child = Bun.spawn(["bundle", "exec", "ruby", "-e", script], {
    cwd: packageRoot,
    env: {
      ...process.env,
      FASTLANE_OPT_OUT_USAGE: "1",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      NATIVE_RELEASE_SECRETS_DIR: scratch,
      NATIVE_RELEASE_TIER: "staging",
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
}

const standardLanes = {
  // Lanes outside a platform.
  "": ["store_build_numbers"],
  android: [
    "build_debug_apk",
    "build_release",
    "build_release_apk",
    "clean",
    "install_debug",
    "install_release",
    "sideload",
    "test",
    "upload_release",
  ],
  ios: [
    "build_release",
    "fetch_profiles",
    "profiles",
    "select_store_build",
    "upload_release",
  ],
};

for (const tier of ["production", "staging"]) {
  test(`the ${tier} Fastfile declares the standard lane names`, async () => {
    const lanes = await runLanes(
      `
lanes = fastfile.runner.lanes.to_h do |platform, platform_lanes|
  [platform.to_s, platform_lanes.keys.map(&:to_s).sort]
end
puts JSON.generate(lanes)
`,
      { NATIVE_RELEASE_TIER: tier },
    );
    expect(lanes).toEqual(standardLanes);
  });
}

test("Play version codes count bundles uploaded outside any track", async () => {
  const jsonKey = join(scratch, "play.json");
  await Bun.write(jsonKey, "{}");
  const result = await runLanes(
    `
calls = []
client = Object.new
client.define_singleton_method(:begin_edit) { |package_name:| calls << "begin:#{package_name}" }
client.define_singleton_method(:aab_version_codes) { [3, 9] }
client.define_singleton_method(:apks_version_codes) { [] }
client.define_singleton_method(:abort_current_edit) { calls << "abort" }
fastfile.define_singleton_method(:google_play_supply_client) { client }
fastfile.define_singleton_method(:google_play_version_codes_by_track) do |tracks|
  tracks.to_h { |track| [track, track == "internal" ? ["4"] : []] }
end
latest = fastfile.send(:latest_google_play_build_number, %w[internal production])
next_build = fastfile.send(:next_android_release_build_number, { next_google_play: true })
puts JSON.generate(latest: latest, next: next_build[:build_number], calls: calls)
`,
    { GOOGLE_PLAY_JSON_KEY_FILE: jsonKey },
  );
  expect(result).toEqual({
    latest: [{ internal: ["4"], production: [] }, 9],
    next: 10,
    calls: [
      "begin:com.balebase.staging.app",
      "abort",
      "begin:com.balebase.staging.app",
      "abort",
    ],
  });
});

test("the signing keychain's cleanup restores the caller's default keychain", async () => {
  const result = await runLanes(`
commands = []
# Every fastlane shell helper (Actions.sh and the Action.sh that
# create_keychain uses to list keychains) runs through sh_control_output.
login = "    \\"/Users/me/Library/Keychains/login.keychain-db\\"\\n"
Fastlane::Actions.define_singleton_method(:sh_control_output) do |*command, **|
  command = command.join(" ")
  commands << command
  ["security default-keychain", "security list-keychains -d user"].include?(command) ? login : ""
end
FastlaneCore::Helper.define_singleton_method(:keychain_path) { |name| "/tmp/#{name}-db" }
restored = [true, false].map do |exists|
  commands.clear
  fastfile.define_singleton_method(:ios_signing_keychain_exists?) { |_name| exists }
  fastfile.send(:create_ios_signing_keychain, "balebase-test", "secret")
  fastfile.send(:cleanup_ios_signing_keychain, "balebase-test")
  commands.select { |command| command.start_with?("security default-keychain -s") }
end
puts JSON.generate(restored)
`);
  const login =
    'security default-keychain -s "/Users/me/Library/Keychains/login.keychain-db"';
  for (const commands of result) {
    expect(commands.at(0)).toContain("balebase-test");
    expect(commands.at(-1)).toBe(login);
  }
});

test("external TestFlight distribution waits for build processing", async () => {
  const result = await runLanes(`
skip = ->(options) { fastfile.send(:testflight_skip_waiting_for_build_processing?, options) }
puts JSON.generate([
  skip.call({}),
  skip.call({ distribute_external: true }),
  skip.call({ distribute_external: true, skip_waiting_for_build_processing: true })
])
`);
  expect(result).toEqual([true, false, true]);
});

test("release lanes accept only a bundled config for the tier's app", async () => {
  const configs = {
    bundled: {
      appId: "com.balebase.staging.app",
      server: { iosScheme: "capacitor" },
    },
    production: { appId: "com.balebase.app" },
    liveReload: {
      appId: "com.balebase.staging.app",
      server: { url: "http://192.168.1.20:5173" },
    },
  };
  for (const [name, config] of Object.entries(configs)) {
    await Bun.write(join(scratch, `${name}.json`), JSON.stringify(config));
  }
  const result = await runLanes(`
results = %w[bundled production liveReload missing].to_h do |name|
  path = File.join(${JSON.stringify(scratch)}, "#{name}.json")
  fastfile.send(:ensure_bundled_release_capacitor_config!, path, "Android", "bun run cap:sync:staging android")
  [name, "accepted"]
rescue FastlaneCore::Interface::FastlaneError => e
  [name, e.message]
end
puts JSON.generate(results)
`);
  expect(result).toEqual({
    bundled: "accepted",
    production: `Release Android builds must be fully bundled, but capacitor.config.json sets appId="com.balebase.app" instead of "com.balebase.staging.app". Run \`bun run cap:sync:staging android\` first.`,
    liveReload:
      "Release Android builds must be fully bundled, but capacitor.config.json sets server.url=http://192.168.1.20:5173 (usually a leftover live-reload URL). Run `bun run cap:sync:staging android` first.",
    missing: expect.stringContaining(
      `Could not load ${join(scratch, "missing.json")}`,
    ),
  });
});

test("release build numbers default to the PR merged last on the release date", async () => {
  const result = await runLanes(
    `
prs = [
  { number: 150, mergedAt: "2026-10-20T23:30:00Z", title: "older" },
  { number: 152, mergedAt: "2026-10-21T09:00:00Z", title: "morning" },
  { number: 153, mergedAt: "2026-10-21T17:00:00Z", title: "afternoon" },
  { number: 154, mergedAt: "2026-10-22T08:00:00Z", title: "next day" }
]
git_log = "1792569600\\u0000feat: one (#140)\\n1792605600\\u0000chore: no PR\\n1792591200\\u0000fix: two (#141)\\n"
commands = []
gh = { ok: true }
fastfile.define_singleton_method(:release_command_available?) { |_command| true }
fastfile.define_singleton_method(:release_command_output) do |*command|
  commands << command.first
  next [JSON.generate(prs), gh[:ok]] if command.first == "gh"

  # Like git log --since/--until, only the release date's commits come back.
  [command.include?("--since=2026-10-21 00:00") ? git_log : "", true]
end
resolve = lambda do |options, env_prefix = "ANDROID"|
  fastfile.send(:merged_release_pr_number, options, env_prefix)
rescue FastlaneCore::Interface::FastlaneError => e
  "error: #{e.message}"
end
results = {
  github: resolve.call({ merged_date: "2026-10-21" }),
  explicit: resolve.call({ merged_pr_number: "77", merged_date: "2026-10-21" }),
  env: (ENV["IOS_RELEASE_PR_NUMBER"] = "88"; resolve.call({}, "IOS")),
  invalid: resolve.call({ merged_pr_number: "0" }),
  badDate: resolve.call({ merged_date: "21/10/2026" }),
  noMatch: resolve.call({ merged_date: "2026-11-01" })
}
commands.clear
gh[:ok] = false
results[:gitFallback] = resolve.call({ merged_date: "2026-10-21" })
results[:fallbackCommands] = commands.dup
puts JSON.generate(results)
`,
    { TZ: "UTC" },
  );
  expect(result).toEqual({
    github: 153,
    explicit: 77,
    env: 88,
    invalid: "error: Merged release PR number must be positive.",
    badDate:
      "error: ANDROID_RELEASE_MERGED_DATE must be YYYY-MM-DD: 21/10/2026",
    noMatch:
      "error: Could not find a PR merged on 2026-11-01. Set ANDROID_RELEASE_PR_NUMBER or pass merged_pr_number:<number>.",
    // The squash subjects carry the PR number; the latest such commit wins.
    gitFallback: 141,
    fallbackCommands: ["gh", "git"],
  });
});

test("Android release lanes choose build numbers and Play upload options", async () => {
  const jsonKey = join(scratch, "play-upload.json");
  await Bun.write(jsonKey, "{}");
  await Bun.write(join(scratch, "balebase-upload.keystore"), "");
  const result = await runLanes(
    `
fastfile.define_singleton_method(:merged_release_pr_number) { |_options, _prefix| 153 }
play = { latest: 4 }
fastfile.define_singleton_method(:latest_google_play_build_number) { |tracks| [{}, play[:latest]] }
number = lambda do |options|
  fastfile.send(:next_android_release_build_number, options)[:build_number]
rescue FastlaneCore::Interface::FastlaneError => e
  "error: #{e.message}"
end
numbers = {
  merged: number.call({}),
  next: number.call({ next_google_play: true }),
  explicit: number.call({ build_number: "9" }),
  gradleEnvironment: (ENV["ANDROID_VERSION_CODE"] = "11"; number.call({})),
  conflict: number.call({ build_number: "9", next_google_play: true }),
  aheadOfMerged: (ENV.delete("ANDROID_VERSION_CODE"); play[:latest] = 300; number.call({}))
}
aab = Fastlane::FastFile.const_get(:RELEASE_AAB_PATH)
assets = { assets: [aab, "/tmp/mapping.txt"] }
upload = fastfile.send(:upload_android_play_release_options, {}, assets)
override = fastfile.send(
  :upload_android_play_release_options,
  { track: "alpha", release_status: "draft", validate_only: true },
  { assets: [aab] }
)
signing = begin
  fastfile.send(:require_android_release_signing!)
  "ok"
rescue FastlaneCore::Interface::FastlaneError => e
  e.message
end
puts JSON.generate(
  numbers: numbers,
  upload: upload.slice(:package_name, :json_key, :mapping_paths, :track, :release_status, :validate_only, :skip_upload_metadata),
  aab: upload[:aab] == aab,
  override: override.slice(:track, :release_status, :validate_only, :mapping_paths),
  signing: signing
)
`,
    {
      GOOGLE_PLAY_JSON_KEY_FILE: jsonKey,
      ANDROID_KEYSTORE_STORE_PASS: "",
      ANDROID_KEYSTORE_KEY_PASS: "",
    },
  );
  expect(result.numbers).toEqual({
    merged: 153,
    next: 5,
    explicit: 9,
    gradleEnvironment: 11,
    conflict:
      "error: Use either build_number or next_google_play:true, not both.",
    aheadOfMerged: 301,
  });
  expect(result.upload).toEqual({
    package_name: "com.balebase.staging.app",
    json_key: jsonKey,
    mapping_paths: ["/tmp/mapping.txt"],
    track: "internal",
    release_status: "completed",
    validate_only: false,
    skip_upload_metadata: true,
  });
  expect(result.aab).toBe(true);
  expect(result.override).toEqual({
    track: "alpha",
    release_status: "draft",
    validate_only: true,
  });
  expect(result.signing).toBe(
    `Android release signing is not configured. Missing ANDROID_KEYSTORE_STORE_PASS, ANDROID_KEYSTORE_KEY_PASS in the environment or ${join(scratch, "app.env")}.`,
  );
});

test("iOS release lanes resolve the signing team and TestFlight groups", async () => {
  const result = await runLanes(
    `
attempt = lambda do |&block|
  block.call
rescue FastlaneCore::Interface::FastlaneError => e
  "error: #{e.message}"
end
build_number = lambda do |options|
  fastfile.send(:next_ios_release_build_number, options)[:build_number]
rescue FastlaneCore::Interface::FastlaneError => e
  "error: #{e.message}"
end
puts JSON.generate(
  buildNumbers: [
    build_number.call({ build_number: "5" }),
    (ENV["APPLE_BUILD_NUMBER"] = "6"; build_number.call({})),
    build_number.call({ build_number: "5", next_testflight: true })
  ],
  teamFromIosName: fastfile.send(:ios_team_id, {}),
  teamOption: fastfile.send(:ios_team_id, { team_id: "OPTION" }),
  missingTeam: attempt.call { ENV.delete("IOS_TEAM_ID"); ENV.delete("TEAM_ID"); fastfile.send(:require_ios_team_id!, {}) },
  groups: fastfile.send(:testflight_groups, { groups: " Staff, ,Beta " }),
  emptyGroups: fastfile.send(:testflight_groups, { groups: " , " }),
  externalWithoutGroups: attempt.call { fastfile.send(:require_testflight_distribution_options!, { distribute_external: true }) },
  submission: [
    fastfile.send(:testflight_skip_submission?, {}),
    fastfile.send(:testflight_skip_submission?, { distribute_external: true })
  ]
)
`,
    { IOS_TEAM_ID: "IOSTEAM", TEAM_ID: "SHARED" },
  );
  expect(result).toEqual({
    buildNumbers: [
      5,
      6,
      "error: Use either build_number or next_testflight:true, not both.",
    ],
    teamFromIosName: "IOSTEAM",
    teamOption: "OPTION",
    missingTeam:
      "error: iOS release signing requires IOS_TEAM_ID, APPLE_TEAM_ID, DEVELOPMENT_TEAM, FASTLANE_TEAM_ID, TEAM_ID, or the team_id:<id> Fastlane option.",
    groups: ["Staff", "Beta"],
    emptyGroups: null,
    externalWithoutGroups:
      "error: External TestFlight distribution requires TESTFLIGHT_GROUPS or groups:<name,name>.",
    submission: [true, false],
  });
});

test("iOS release lanes take the package version and create profiles with the API key", async () => {
  const { version } = await Bun.file(join(packageRoot, "package.json")).json();
  const result = await runLanes(`
calls = []
fastfile.define_singleton_method(:load_ios_release_secrets_env) {}
fastfile.define_singleton_method(:with_ios_signing_keychain) do |&block|
  calls << "keychain"
  block.call
end
fastfile.define_singleton_method(:app_store_connect_api_key_options) { { key_id: "KEY" } }
fastfile.define_singleton_method(:app_store_connect_api_key) { |options| "api-key:#{options[:key_id]}" }
fastfile.define_singleton_method(:match) { |options| calls << options }
fastfile.runner.execute(:profiles, :ios, {})
fastfile.runner.execute(:profiles, :ios, { force: true })
puts JSON.generate(
  version: fastfile.send(:ios_release_version, {}),
  explicitVersion: fastfile.send(:ios_release_version, { version: "2.0.0" }),
  calls: calls
)
`);
  const profile = {
    type: "appstore",
    app_identifier: "com.balebase.staging.app",
    api_key: "api-key:KEY",
    readonly: false,
  };
  expect(result).toEqual({
    version,
    explicitVersion: "2.0.0",
    calls: [
      "keychain",
      { ...profile, force: false },
      "keychain",
      { ...profile, force: true },
    ],
  });
});

test("App Store drafts select an explicit processed build without submitting", async () => {
  const result = await runLanes(`
require "ostruct"
scenarios = %w[empty repeat replace renamedSelected processing expired noIcon missing ambiguous noDraft inReview notRetained]
results = scenarios.to_h do |scenario|
  calls = []
  build = OpenStruct.new(
    id: "uploaded", pre_release_version: OpenStruct.new(platform: "IOS"),
    processing_state: scenario == "processing" ? "PROCESSING" : "VALID",
    expired: scenario == "expired", icon_asset_token: scenario == "noIcon" ? nil : { "templateUrl" => "icon.png" }
  )
  selected = case scenario
             when "repeat" then build
             when "replace", "renamedSelected" then OpenStruct.new(id: "old")
             end
  draft = OpenStruct.new(
    id: "draft", version_string: %w[repeat replace].include?(scenario) ? "0.1.63" : "1.0",
    build: selected, app_version_state: scenario == "inReview" ? "IN_REVIEW" : "PREPARE_FOR_SUBMISSION"
  )
  draft.define_singleton_method(:update) do |attributes:|
    calls << ["version", attributes]
    self.version_string = attributes.fetch(:versionString)
    self
  end
  draft.define_singleton_method(:select_build) do |build_id:|
    calls << ["build", build_id]
    self.build = build unless scenario == "notRetained"
  end
  app = Object.new
  app.define_singleton_method(:get_builds) do |filter:, includes:|
    raise "Wrong build lookup" unless filter == { "preReleaseVersion.version" => "0.1.63", version: "1" }
    raise "Missing platform lookup" unless includes == "preReleaseVersion"
    next [] if scenario == "missing"
    next [build, build] if scenario == "ambiguous"

    [build]
  end
  app.define_singleton_method(:get_app_store_versions) do |filter:, includes:|
    raise "Wrong draft platform" unless filter[:platform] == "IOS" && includes == "build"
    next [] if scenario == "noDraft"
    next [] if filter[:appVersionState] && filter[:appVersionState] != draft.app_version_state

    [draft]
  end
  outcome = begin
    AppStoreBuild.select(app, version: "0.1.63", build_number: "1").id
  rescue AppStoreBuild::SelectionError => e
    e.message
  end
  [scenario, { outcome: outcome, calls: calls }]
end
puts JSON.generate(results)
`);
  expect(result.empty).toEqual({
    outcome: "draft",
    calls: [
      ["version", { versionString: "0.1.63" }],
      ["build", "uploaded"],
    ],
  });
  expect(result.repeat).toEqual({ outcome: "draft", calls: [] });
  expect(result.replace).toEqual({
    outcome: "draft",
    calls: [["build", "uploaded"]],
  });
  expect(result.renamedSelected).toEqual({
    outcome: "Cannot rename a draft that already has a selected build.",
    calls: [],
  });
  for (const name of ["processing", "expired", "noIcon"]) {
    expect(result[name]).toEqual({
      outcome:
        "The uploaded build must be processed, unexpired, and contain an app icon.",
      calls: [],
    });
  }
  for (const name of ["missing", "ambiguous"]) {
    expect(result[name]).toEqual({
      outcome:
        "Expected exactly one uploaded iOS build for that version and build number.",
      calls: [],
    });
  }
  for (const name of ["noDraft", "inReview"]) {
    expect(result[name]).toEqual({
      outcome: "Expected exactly one iOS version in Prepare for Submission.",
      calls: [],
    });
  }
  expect(result.notRetained.outcome).toBe(
    "App Store Connect did not retain the selected build.",
  );
});

test("App Store selection requires explicit identifiers and uses the tier's app", async () => {
  const result = await runLanes(`
calls = []
fastfile.define_singleton_method(:load_store_secrets_env) { calls << "credentials" }
fastfile.define_singleton_method(:app_store_connect_api_key_options) { { key_id: "KEY" } }
fastfile.define_singleton_method(:app_store_connect_api_key) { |_options| calls << "authenticate" }
Spaceship::ConnectAPI::App.define_singleton_method(:find) { |identifier| calls << identifier; "app" }
AppStoreBuild.define_singleton_method(:select) do |app, version:, build_number:|
  calls << [app, version, build_number]
  Struct.new(:id, :version_string).new("draft", version)
end
missing = begin
  fastfile.runner.execute(:select_store_build, :ios, {})
rescue FastlaneCore::Interface::FastlaneError => e
  e.message
end
before = calls.dup
selected = fastfile.runner.execute(:select_store_build, :ios, { version: "0.1.63", build_number: "1" })
puts JSON.generate(missing: missing, before: before, selected: selected, calls: calls)
`);
  expect(result).toEqual({
    missing:
      "Pass version:<marketing-version> and build_number:<uploaded-build>.",
    before: [],
    selected: "draft",
    calls: [
      "credentials",
      "authenticate",
      "com.balebase.staging.app",
      ["app", "0.1.63", "1"],
    ],
  });
});
