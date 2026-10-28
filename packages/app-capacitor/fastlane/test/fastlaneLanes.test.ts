import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFastfileScenarios } from "./support/fastfileScenarios";

// Each test asserts one scenario from fastlane/test/support/scenarios. They
// run together against the staging Fastfile, each in its own forked process.
const packageRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(packageRoot, "../..");
const app = "com.balebase.staging.app";
const scratch = await mkdtemp(join(tmpdir(), "balebase-fastlane-lanes-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const scenario = await runFastfileScenarios(
  [
    "play_version_codes",
    "android_release_options",
    "signing_keychain_cleanup",
    "testflight_external_waits",
    "ios_release_options",
    "ios_profiles",
    "bundled_release_config",
    "release_url_guards",
    "release_lanes_refuse_foreign_hosts",
    "merged_release_pr",
    "release_build_receipts",
    "app_store_build_select",
    "select_store_build_lane",
    "readiness_lanes",
    "ios_readiness_precheck",
  ],
  scratch,
  { NATIVE_RELEASE_TIER: "staging", TZ: "UTC" },
);

test("Play version codes count bundles uploaded outside any track", () => {
  expect(scenario("play_version_codes")).toEqual({
    latest: [{ internal: ["4"], production: [] }, 9],
    next: {
      build_number: 10,
      google_play_latest_build_number: 9,
      merged_pr_number: null,
    },
    calls: [`begin:${app}`, "abort", `begin:${app}`, "abort"],
  });
});

test("Android release lanes choose build numbers and Play upload options", () => {
  const result = scenario("android_release_options");
  const build = (
    build_number: number,
    google_play_latest_build_number: number | null = null,
    merged_pr_number: number | null = null,
  ) => ({ build_number, google_play_latest_build_number, merged_pr_number });
  expect(result.builds).toEqual({
    merged: build(153, 4, 153),
    next: build(5, 4),
    explicit: build(9),
    gradleEnvironment: build(11),
    aheadOfMerged: build(301, 300, 153),
  });
  expect(result.upload).toEqual({
    package_name: app,
    json_key: join(scratch, "play-upload.json"),
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
    `Android release signing is not configured. Missing ANDROID_KEYSTORE_STORE_PASS, ANDROID_KEYSTORE_KEY_PASS in the environment, ${join(scratch, "shared.env")}, or ${join(scratch, "app.env")}.`,
  );
});

test("the signing keychain's cleanup restores the caller's default keychain", () => {
  const login =
    'security default-keychain -s "/Users/me/Library/Keychains/login.keychain-db"';
  for (const commands of scenario("signing_keychain_cleanup")) {
    expect(commands.at(0)).toContain("balebase-test");
    expect(commands.at(-1)).toBe(login);
  }
});

test("external TestFlight distribution waits for build processing", () => {
  expect(scenario("testflight_external_waits")).toEqual([true, false, true]);
});

test("iOS release lanes choose build numbers and resolve the signing team and TestFlight groups", async () => {
  const { version } = await Bun.file(join(packageRoot, "package.json")).json();
  const build = (
    build_number: number,
    testflight_latest_build_number: number | null = null,
    merged_pr_number: number | null = null,
    buildVersion: string = version,
  ) => ({
    build_number,
    merged_pr_number,
    testflight_latest_build_number,
    version: buildVersion,
  });
  expect(scenario("ios_release_options")).toEqual({
    builds: {
      explicit: build(5, null, null, "2.0.0"),
      appleEnvironment: build(6),
      // TestFlight's 0 for a version without builds counts as none.
      firstOfVersion: build(1),
      aheadOfMerged: build(301, 300, 153),
    },
    testflightVersions: [version, version],
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
  const profile = {
    type: "appstore",
    app_identifier: app,
    api_key: "api-key:KEY",
    readonly: false,
  };
  expect(scenario("ios_profiles")).toEqual({
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

test("release lanes accept only a bundled config for the tier's app", () => {
  expect(scenario("bundled_release_config")).toEqual({
    bundled: "accepted",
    production: `Release Android builds must be fully bundled, but capacitor.config.json sets appId="com.balebase.app" instead of "${app}". Run \`bun run cap:sync:staging android\` first.`,
    liveReload:
      "Release Android builds must be fully bundled, but capacitor.config.json sets server.url=http://192.168.1.20:5173 (usually a leftover live-reload URL). Run `bun run cap:sync:staging android` first.",
    missing: expect.stringContaining(
      `Could not load ${join(scratch, "missing.json")}`,
    ),
  });
});

test("release URL guards fail as fastlane user errors", () => {
  expect(scenario("release_url_guards")).toEqual({
    class: "FastlaneCore::Interface::FastlaneError",
    message:
      "VITE_APP_URL must use app-staging.balebase.com for a staging release.",
  });
});

test("release lanes refuse another tier's host before building", () => {
  const refused = {
    error:
      "VITE_APP_URL must use app-staging.balebase.com for a staging release.",
    events: [],
  };
  expect(scenario("release_lanes_refuse_foreign_hosts")).toEqual({
    ios: refused,
    android: refused,
  });
});

test("release build numbers default to the PR merged last on the release date", () => {
  expect(scenario("merged_release_pr")).toEqual({
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

test("release builds record their source before building and a receipt after", () => {
  const result = scenario("release_build_receipts");
  const source = { commit: "a".repeat(40), dirty: false };

  expect(result.ios.at(0)).toEqual(["source", repoRoot]);
  expect(result.ios.slice(-2)).toEqual([
    ["build_app"],
    ["receipt", result.ipa, source, repoRoot],
  ]);
  expect(result.android.at(0)).toEqual(["source", repoRoot]);
  expect(result.android.slice(-2)).toEqual([
    ["gradle", "bundleStaging"],
    ["receipt", result.aab, source, repoRoot],
  ]);
});

test("App Store drafts select an explicit processed build without submitting", () => {
  const result = scenario("app_store_build_select");
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

test("App Store selection requires explicit identifiers and uses the tier's app", () => {
  expect(scenario("select_store_build_lane")).toEqual({
    missing:
      "Pass version:<marketing-version> and build_number:<uploaded-build>.",
    before: [],
    selected: "draft",
    calls: ["credentials", "authenticate", app, ["app", "0.1.63", "1"]],
  });
});

const checkStatus = (
  report: { checks: { id: string; status: string }[] },
  id: string,
) => report.checks.find((check) => check.id === id)?.status;

test("readiness lanes report offline, honor strict mode, and protect their artifact", () => {
  const result = scenario("readiness_lanes");
  const { ipa, aab } = result;

  expect(checkStatus(result.offline, "fixture.ios")).toBe("verified");
  expect(checkStatus(result.offline, "store.ios")).toBe("unverified");
  expect(checkStatus(result.offline, "manual.accessibility_devices")).toBe(
    "unverified",
  );
  expect(result.offline.result).toBe("incomplete");
  expect(result.strict).toStartWith("Readiness is incomplete");
  expect(result.strictReport).toBe("incomplete");
  expect(checkStatus(result.android, "fixture.store")).toBe("verified");
  expect(checkStatus(result.androidOffline, "store.android")).toBe(
    "unverified",
  );
  expect(result.inspected).toEqual([
    [
      "ios",
      ipa,
      {
        targets: { [app]: [] },
        privacy: {
          tracking: false,
          collected_data_types: Object.fromEntries(
            [
              "Name",
              "EmailAddress",
              "PhoneNumber",
              "PhysicalAddress",
              "UserID",
              "OtherFinancialInfo",
              "PurchaseHistory",
              "PhotosorVideos",
              "EmailsOrTextMessages",
              "OtherUserContent",
              "OtherUsageData",
              "OtherDataTypes",
              "CrashData",
              "OtherDiagnosticData",
            ].map((type) => [
              `NSPrivacyCollectedDataType${type}`,
              {
                linked: type !== "CrashData" && type !== "OtherDiagnosticData",
                tracking: false,
                purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
              },
            ]),
          ),
          accessed_api_reasons: {
            NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1"],
          },
        },
      },
    ],
    ["ios", ipa, expect.objectContaining({ targets: { [app]: [] } })],
    [
      "android",
      aab,
      {
        identifier: app,
        permissions: [
          "android.permission.INTERNET",
          `${app}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
        ],
        minified: false,
      },
      resolve(repoRoot, "tools/from-env.jar"),
    ],
    [
      "android",
      aab,
      expect.objectContaining({ identifier: app }),
      resolve(repoRoot, "tools/explicit.jar"),
    ],
  ]);
  expect(result.stores).toEqual([
    {
      package: app,
      key_path: "google-play-service-account-admin.json",
      listing: { locales: ["en-US"], screenshot_locale: "en-US" },
      track: "beta",
    },
  ]);
  expect(result.defaults).toEqual([
    "/fixture/candidate.ipa",
    resolve(repoRoot, ".readiness/staging/ios.json"),
  ]);
  expect(result.errors).toEqual({
    overwrite: "Report output must not overwrite its artifact or build receipt",
    receipt: "Report output must not overwrite its artifact or build receipt",
    timeout: "wait_timeout must be between 0 and 1800 seconds",
    longTimeout: "wait_timeout must be between 0 and 1800 seconds",
    track:
      'Unsupported Play track "qa"; use one of production, beta, alpha, internal',
    store: "Invalid boolean for store: maybe. Expected true or false.",
  });
});

test("iOS readiness separates precheck rejection, setup errors, and a skipped precheck", () => {
  const { reports, calls } = scenario("ios_readiness_precheck");

  expect(checkStatus(reports.pass, "store.precheck")).toBe("verified");
  expect(checkStatus(reports.pass, "fixture.store")).toBe("verified");
  expect(checkStatus(reports.rejected, "store.precheck")).toBe("failed");
  expect(checkStatus(reports.error, "store.precheck")).toBe("unverified");
  expect(JSON.stringify(reports.error)).not.toContain(
    "private authentication diagnostic",
  );
  expect(checkStatus(reports.skipped, "store.precheck")).toBe("unverified");
  const store = {
    app,
    listing: { locales: ["en-US"], screenshot_locale: "en-US" },
    timeout: 30,
  };
  const precheck = { precheck: app, api_key: "api-key", purchases: false };
  expect(calls).toEqual([
    store,
    precheck,
    store,
    precheck,
    store,
    precheck,
    store,
  ]);
});
