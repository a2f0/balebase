import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRubyBundle } from "./requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "balebase-fastlane-lanes-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/**
 * Loads the real Fastfile, runs `body` against it as `fastfile`, and returns
 * the JSON the body prints last.
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
Fastlane::Actions.define_singleton_method(:sh) do |command, **|
  commands << command
  command == "security default-keychain" ? "    \\"/Users/me/Library/Keychains/login.keychain-db\\"\\n" : ""
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
