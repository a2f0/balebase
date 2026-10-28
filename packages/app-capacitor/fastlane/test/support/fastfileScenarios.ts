import { resolve } from "node:path";
import { requireRubyBundle } from "./requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "../../..");

// Release options the lanes read from the environment, by prefix because some
// names are built at run time; the caller's values must not change results.
const releaseOptionPrefixes =
  /^(ANDROID|APP_STORE|APPLE|BUNDLETOOL|GOOGLE_PLAY|IOS|MATCH|READINESS|SKIP|SUPPLY|TESTFLIGHT|VITE)_/;
const releaseOptionNames = ["DEVELOPMENT_TEAM", "FASTLANE_TEAM_ID", "TEAM_ID"];

/**
 * Runs the named scenarios from fastlane/test/support/scenarios against the
 * real Fastfile in one Ruby process, and returns a lookup that gives each
 * scenario's result or throws its error. `fixtures` is the folder scenarios
 * write to; the Fastfile also reads the tier's secrets from it.
 */
export async function runFastfileScenarios(
  names: string[],
  fixtures: string,
  env: Record<string, string> = {},
) {
  await requireRubyBundle();
  const callerEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !releaseOptionPrefixes.test(name) && !releaseOptionNames.includes(name),
    ),
  );
  const child = Bun.spawn(
    [
      "bundle",
      "exec",
      "ruby",
      "fastlane/test/support/fastfile_scenarios.rb",
      ...names,
    ],
    {
      cwd: packageRoot,
      env: {
        ...callerEnvironment,
        FASTFILE_SCENARIO_DIR: fixtures,
        FASTLANE_OPT_OUT_USAGE: "1",
        FASTLANE_SKIP_UPDATE_CHECK: "1",
        NATIVE_RELEASE_SECRETS_DIR: fixtures,
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Fastfile scenarios failed (${exitCode}): ${stderr}`);
  }
  // Each test asserts its own scenario's JSON shape.
  const outcomes = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  return (name: string) => {
    const outcome = outcomes[name];
    if (outcome === undefined) throw new Error(`Scenario ${name} did not run`);
    if (outcome.error !== undefined) {
      throw new Error(`${name}: ${outcome.error}`);
    }
    return outcome.value;
  };
}
