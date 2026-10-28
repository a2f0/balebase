import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFastfileScenarios } from "./support/fastfileScenarios";

const scratch = await mkdtemp(join(tmpdir(), "balebase-lane-options-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

// fastlane/test/support/scenarios/lane_options.rb; build-number options are
// covered in releaseBuildNumber.test.ts.
test("lanes take one name per option and keep their environment fallbacks", async () => {
  const scenario = await runFastfileScenarios(["lane_options"], scratch, {
    NATIVE_RELEASE_TIER: "production",
  });

  expect(scenario("lane_options")).toEqual({
    defaultTrack: "internal",
    track: "beta",
    queriedTrack: ["beta"],
    defaultQueriedTracks: ["production", "beta", "alpha", "internal"],
    releaseStatus: "completed",
    teamOption: "OPTION",
    teamAliasOption: null,
    iosVersion: "2.0.0",
    iosAppleVersionOption: null,
    mergedPrNumber: 47,
    prNumberOption: null,
    envTrack: "alpha",
    teamEnv: "SHARED",
    iosAppleVersionEnv: "2.0.2",
    prNumberEnv: 49,
  });
});
