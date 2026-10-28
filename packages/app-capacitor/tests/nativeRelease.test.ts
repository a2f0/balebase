import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const nativeReleaseScript = resolve(repoRoot, "scripts/lib/nativeRelease.sh");
const { scripts: rootScripts } = (await Bun.file(
  resolve(repoRoot, "package.json"),
).json()) as { scripts: Record<string, string> };

async function runShell(
  script: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
) {
  const child = Bun.spawn(["sh", "-c", script, ...args], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Runs scripts/lib/nativeRelease.sh from a temporary checkout with `bundle`
 * stubbed to log its directory, tier, bundle URLs, and arguments, and with an
 * existing Gradle wrapper in the native project.
 */
async function runRelease(args: string[], env: Record<string, string> = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "balebase-native-"));
  const log = resolve(directory, "release.log");
  const scriptPath = resolve(directory, "scripts/lib/nativeRelease.sh");
  await Bun.write(scriptPath, Bun.file(nativeReleaseScript));
  await Bun.write(
    resolve(
      directory,
      "packages/app-capacitor/android/gradle/wrapper/gradle-wrapper.jar",
    ),
    "fixture",
  );
  await Bun.write(
    resolve(directory, "bin/bundle"),
    [
      "#!/bin/sh",
      'printf \'%s:%s:%s:%s:%s\\n\' "$(basename "$PWD")" "$NATIVE_RELEASE_TIER" "$VITE_API_URL" "$VITE_APP_URL" "$*" >> "$NATIVE_RELEASE_TEST_LOG"',
      'for file in "$ANDROID_RELEASE_BUILD_NUMBER_FILE" "$IOS_RELEASE_BUILD_NUMBER_FILE"; do [ -z "$file" ] || echo 7 > "$file"; done',
    ].join("\n"),
  );
  await chmod(resolve(directory, "bin/bundle"), 0o755);
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(ANDROID|IOS|APPLE|VITE|NATIVE_RELEASE)_/.test(name)) {
      Reflect.deleteProperty(environment, name);
    }
  }
  try {
    const result = await runShell('exec sh "$@"', ["sh", scriptPath, ...args], {
      ...environment,
      ...env,
      NATIVE_RELEASE_TEST_LOG: log,
      PATH: `${resolve(directory, "bin")}:${Reflect.get(process.env, "PATH") ?? ""}`,
    });
    const calls = (await Bun.file(log).exists())
      ? (await Bun.file(log).text()).trim().split("\n")
      : [];
    return { ...result, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const releaseTargets = ["android", "ios"].flatMap((platform) =>
  ["build", "upload"].flatMap((action) =>
    ["production", "staging"].map((tier) => ({
      action,
      platform,
      script: `mobile:${action}:${platform}${tier === "staging" ? ":staging" : ""}`,
      tier,
    })),
  ),
);

describe("native release entrypoint", () => {
  test("each root mobile release script names its own target", () => {
    const releaseScripts = Object.keys(rootScripts).filter((name) =>
      /^mobile:(build|upload):/.test(name),
    );
    expect(releaseScripts.sort()).toEqual(
      releaseTargets.map(({ script }) => script).sort(),
    );
    for (const { action, platform, script, tier } of releaseTargets) {
      expect(rootScripts[script], script).toBe(
        `sh scripts/lib/nativeRelease.sh ${platform} ${action} ${tier}`,
      );
    }
  });

  test("every tier runs its platform's lane the same way", async () => {
    for (const { action, platform, tier } of releaseTargets) {
      const { exitCode, stdout, stderr, calls } = await runRelease([
        platform,
        action,
        tier,
        "build_number:42",
      ]);
      expect(exitCode, stderr).toBe(0);
      // The lanes, not this script, choose and check the bundle's hosts.
      expect(calls).toEqual([
        `app-capacitor:${tier}:::exec fastlane ${platform} ${action}_release build_number:42`,
      ]);
      if (action === "upload") expect(stdout).toContain("Build number: 7");
    }
  });

  test("uploads default to the store's next build number and report it", async () => {
    for (const [platform, option] of [
      ["android", "next_google_play:true"],
      ["ios", "next_testflight:true"],
    ] as const) {
      for (const tier of ["production", "staging"]) {
        const { exitCode, stdout, stderr, calls } = await runRelease([
          platform,
          "upload",
          tier,
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(calls).toEqual([
          `app-capacitor:${tier}:::exec fastlane ${platform} upload_release ${option}`,
        ]);
        expect(stdout).toContain("Build number: 7");
      }
    }
  });

  test("a chosen build number, PR, or merge date passes through unchanged", async () => {
    const chosen: [string, Record<string, string>, string[]][] = [
      ["android", { ANDROID_VERSION_CODE: "12" }, []],
      ["android", { ANDROID_RELEASE_MERGED_DATE: "2026-10-21" }, []],
      ["ios", { APPLE_BUILD_NUMBER: "12" }, []],
      ["ios", {}, ["merged_pr_number:153"]],
    ];
    for (const [platform, env, args] of chosen) {
      const { calls } = await runRelease(
        [platform, "upload", "staging", ...args],
        env,
      );
      expect(calls).toEqual([
        ["app-capacitor:staging:::exec fastlane", platform, "upload_release"]
          .concat(args)
          .join(" "),
      ]);
    }
  });

  test("the bundle's URLs reach the lanes, which check them", async () => {
    const { calls } = await runRelease(["android", "build", "staging"], {
      VITE_API_URL: "https://api.balebase.com",
    });
    expect(calls).toEqual([
      "app-capacitor:staging:https://api.balebase.com::exec fastlane android build_release",
    ]);
  });

  test("an unknown platform or action is rejected, even with --help", async () => {
    for (const [platform, action] of [
      ["desktop", "build"],
      ["ios", "deploy"],
    ]) {
      for (const extra of [[], ["--help"]]) {
        const { exitCode, stderr, calls } = await runRelease([
          platform ?? "",
          action ?? "",
          "staging",
          ...extra,
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain(
          `Error: unknown native release ${platform} ${action}; expected <android|ios> <build|upload>.`,
        );
        expect(calls).toEqual([]);
      }
    }
    const missingTier = await runRelease(["ios", "build"]);
    expect(missingTier.exitCode).toBe(1);
    expect(missingTier.stderr).toContain("Error: name the release tier");
    expect(missingTier.calls).toEqual([]);
  });

  test("--help prints the usage without running a lane", async () => {
    for (const args of [["--help"], ["ios", "upload", "staging", "-h"]]) {
      const { exitCode, stdout, calls } = await runRelease(args);
      expect(exitCode).toBe(0);
      expect(stdout).toStartWith(
        "Usage: sh scripts/lib/nativeRelease.sh <android|ios> <build|upload> <tier>",
      );
      expect(calls).toEqual([]);
    }
  });

  test("sourcing the script defines its functions without running them", async () => {
    const { exitCode, stdout, stderr } = await runShell(
      '. "$1"; command -v native_release_main',
      ["sh", nativeReleaseScript],
    );
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("native_release_main");
  });

  test("a fresh checkout restores the Gradle wrapper with the native images", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "balebase-gradle-"));
    const log = resolve(directory, "bun.log");
    await Bun.write(
      resolve(directory, "bin/bun"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BUN_LOG"\n',
    );
    await chmod(resolve(directory, "bin/bun"), 0o755);
    const ensure = (cwd: string) =>
      runShell(
        '. "$1"; cd "$2"; native_release_ensure_android_wrapper',
        ["sh", nativeReleaseScript, cwd],
        {
          ...process.env,
          BUN_LOG: log,
          PATH: `${resolve(directory, "bin")}:${Reflect.get(process.env, "PATH") ?? ""}`,
        },
      );
    try {
      const fresh = resolve(directory, "fresh");
      await Bun.write(resolve(fresh, "android/gradlew"), "");
      expect((await ensure(fresh)).exitCode).toBe(0);
      expect(await Bun.file(log).text()).toBe("run cap:prepare\n");

      const prepared = resolve(directory, "prepared");
      await Bun.write(
        resolve(prepared, "android/gradle/wrapper/gradle-wrapper.jar"),
        "",
      );
      expect((await ensure(prepared)).exitCode).toBe(0);
      expect(await Bun.file(log).text()).toBe("run cap:prepare\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
