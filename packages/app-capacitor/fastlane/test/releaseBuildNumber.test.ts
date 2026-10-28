import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { requireRubyBundle } from "./support/requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "../..");

interface Outcome {
  result?: {
    build_number: number;
    merged_pr_number: number | null;
    store_build_number: number | null;
  };
  error?: string;
  calls: string[];
  logs: string[];
}

// The cases fastlane/test/support/release_build_number_cases.rb runs.
const caseNames = [
  "explicitOption",
  "explicitEnv",
  "toolEnv",
  "optionBeatsEnv",
  "aliasesIgnored",
  "invalidExplicit",
  "conflict",
  "next",
  "nextFromEnv",
  "nextSkipped",
  "nextWithoutCredentials",
  "nextLookupFailure",
  "automatic",
  "automaticStoreAhead",
  "automaticEnvPr",
  "automaticWithoutCredentials",
  "automaticSkipped",
  "automaticLookupFailure",
] as const;
type Cases = Record<(typeof caseNames)[number], Outcome>;

// The release options and guards the cases set themselves; the caller's
// values must not change results.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(ANDROID|APPLE|IOS|SKIP)_/.test(name),
  ),
);

async function runCases() {
  await requireRubyBundle();
  const child = Bun.spawn(
    [
      "bundle",
      "exec",
      "ruby",
      "fastlane/test/support/release_build_number_cases.rb",
    ],
    { cwd: packageRoot, env: environment, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as Record<
    string,
    Cases
  >;
}

const outcomes = await runCases();

// Each platform's wording; every case below must differ only by these.
const platforms = {
  android: {
    platform: "Android",
    store: "Google Play",
    credentials: "Google Play credentials",
    guard: "Google Play version-code guard",
    next: "next_google_play",
  },
  ios: {
    platform: "iOS",
    store: "TestFlight",
    credentials: "App Store Connect credentials",
    guard: "TestFlight build-number guard",
    next: "next_testflight",
  },
};

const result = (
  build_number: number,
  merged_pr_number: number | null = null,
  store_build_number: number | null = null,
) => ({ result: { build_number, merged_pr_number, store_build_number } });

for (const [platform, names] of Object.entries(platforms)) {
  const cases = outcomes[platform] as Cases;
  const latest = (count: number | string) =>
    `${names.store} latest build number: ${count} (fixture scope)`;

  describe(`${names.platform} release build numbers`, () => {
    test("every case ran", () => {
      expect(Object.keys(cases).sort()).toEqual([...caseNames].sort());
    });

    test("an explicit number wins without reading the store", () => {
      expect(cases.explicitOption).toEqual({
        ...result(9),
        calls: [],
        logs: [],
      });
      expect(cases.explicitEnv).toEqual({ ...result(10), calls: [], logs: [] });
      expect(cases.toolEnv).toEqual({ ...result(11), calls: [], logs: [] });
      expect(cases.optionBeatsEnv).toEqual({
        ...result(9),
        calls: [],
        logs: [],
      });
      // Only build_number: names the number; other spellings are ignored.
      expect(cases.aliasesIgnored).toMatchObject(result(153, 153));
      expect(cases.invalidExplicit.error).toBe(
        `${names.platform} release build number must be positive.`,
      );
      expect(cases.conflict.error).toBe(
        `Use either build_number or ${names.next}:true, not both.`,
      );
    });

    test(`${names.next}:true takes the store's latest plus one`, () => {
      expect(cases.next).toEqual({
        ...result(5, null, 4),
        calls: ["configured", "latest"],
        logs: [latest(4), `Using next ${names.store} build number: 5`],
      });
      expect(cases.nextFromEnv).toMatchObject(result(1));
      expect(cases.nextSkipped).toEqual({
        error: `${names.next} requires ${names.store} version lookup.`,
        calls: [],
        logs: [],
      });
      expect(cases.nextWithoutCredentials).toEqual({
        error: `${names.next} requires ${names.credentials}.`,
        calls: ["configured"],
        logs: [],
      });
      expect(cases.nextLookupFailure.error).toBe(
        `Failed to resolve next ${names.store} build number: store offline`,
      );
    });

    test("otherwise the merged PR, kept ahead of the store", () => {
      expect(cases.automatic).toEqual({
        ...result(153, 153, 4),
        calls: ["configured", "latest"],
        logs: [latest(4)],
      });
      expect(cases.automaticStoreAhead).toMatchObject(result(301, 153, 300));
      expect(cases.automaticEnvPr).toEqual({
        ...result(88, 88),
        calls: ["configured", "latest"],
        logs: [latest("none")],
      });
      expect(cases.automaticWithoutCredentials).toEqual({
        ...result(153, 153),
        calls: ["configured"],
        logs: [
          `${names.credentials} not found; using merged PR number without ${names.guard}.`,
        ],
      });
      expect(cases.automaticSkipped).toEqual({
        ...result(153, 153),
        calls: [],
        logs: [`Skipping ${names.guard} as requested.`],
      });
      expect(cases.automaticLookupFailure.error).toBe(
        `Failed to verify ${names.store} build number: store offline`,
      );
    });
  });
}
