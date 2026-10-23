import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const scriptsRoot = resolve(import.meta.dir, "../../../scripts");
const nativeReleaseScript = resolve(scriptsRoot, "lib/nativeRelease.sh");

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
 * Runs a wrapper with `bun` stubbed to log its tier, URLs, and arguments, and
 * with an existing Gradle wrapper in a temporary native project.
 */
async function runWrapper(
  wrapper: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), "balebase-native-"));
  const log = resolve(directory, "release.log");
  const wrapperPath = resolve(directory, "scripts/release", wrapper);
  await Bun.write(
    wrapperPath,
    Bun.file(resolve(scriptsRoot, "release", wrapper)),
  );
  await Bun.write(
    resolve(directory, "scripts/lib/nativeRelease.sh"),
    Bun.file(nativeReleaseScript),
  );
  await Bun.write(
    resolve(
      directory,
      "packages/app-capacitor/android/gradle/wrapper/gradle-wrapper.jar",
    ),
    "fixture",
  );
  await Bun.write(
    resolve(directory, "bun"),
    [
      "#!/bin/sh",
      'printf \'bun:%s:%s:%s:%s\\n\' "$NATIVE_RELEASE_TIER" "$VITE_API_URL" "$VITE_APP_URL" "$*" >> "$NATIVE_RELEASE_TEST_LOG"',
      '[ -z "$ANDROID_RELEASE_BUILD_NUMBER_FILE" ] || echo 7 > "$ANDROID_RELEASE_BUILD_NUMBER_FILE"',
    ].join("\n"),
  );
  await chmod(resolve(directory, "bun"), 0o755);
  const environment = { ...process.env };
  for (const name of ["VITE_API_URL", "VITE_APP_URL", "NATIVE_RELEASE_TIER"])
    Reflect.deleteProperty(environment, name);
  try {
    const result = await runShell(
      'wrapper="$1"; shift; exec sh "$wrapper" "$@"',
      ["sh", wrapperPath, ...args.slice(3)],
      {
        ...environment,
        ...env,
        NATIVE_RELEASE_TEST_LOG: log,
        PATH: `${directory}:${Reflect.get(process.env, "PATH") ?? ""}`,
      },
    );
    const calls = (await Bun.file(log).exists())
      ? (await Bun.file(log).text()).trim().split("\n")
      : [];
    return { ...result, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("native release wrappers", () => {
  test("each wrapper runs its own tier's lane", async () => {
    const wrappers = [
      [
        "buildAndroidRelease.sh",
        "android build production",
        "android:build-release",
      ],
      [
        "buildAndroidStagingRelease.sh",
        "android build staging",
        "android:build-release:staging",
      ],
      ["buildIosRelease.sh", "ios build production", "ios:build-release"],
      [
        "buildIosStagingRelease.sh",
        "ios build staging",
        "ios:build-release:staging",
      ],
    ];
    for (const [wrapper, target, command] of wrappers) {
      const source = await Bun.file(
        resolve(scriptsRoot, "release", wrapper ?? ""),
      ).text();
      expect(source).toContain(`native_release_main ${target} "$@"`);
      const [platform, action, tier] = (target ?? "").split(" ");
      const { exitCode, stderr, calls } = await runWrapper(wrapper ?? "", [
        platform ?? "",
        action ?? "",
        tier ?? "",
        "build_number:42",
      ]);
      expect(exitCode, stderr).toBe(0);
      const host = tier === "staging" ? "-staging" : "";
      expect(calls).toEqual([
        `bun:${tier}:https://api${host}.balebase.com:https://app${host}.balebase.com:run ${command} build_number:42`,
      ]);
    }
  });

  test("uploads default to the store's next build number and report it", async () => {
    const { exitCode, stdout, stderr, calls } = await runWrapper(
      "uploadAndroidStagingRelease.sh",
      ["android", "upload", "staging"],
    );
    expect(exitCode, stderr).toBe(0);
    expect(calls).toEqual([
      "bun:staging:https://api-staging.balebase.com:https://app-staging.balebase.com:run android:upload-release:staging next_google_play:true",
    ]);
    expect(stdout).toContain("Build number: 7");
  });

  test("an explicit build number is passed through unchanged", async () => {
    const { calls } = await runWrapper(
      "uploadAndroidRelease.sh",
      ["android", "upload", "production"],
      { ANDROID_VERSION_CODE: "12" },
    );
    expect(calls).toEqual([
      "bun:production:https://api.balebase.com:https://app.balebase.com:run android:upload-release",
    ]);
  });

  for (const [name, url, message] of [
    [
      "VITE_API_URL",
      "https://api.balebase.com",
      "A staging release must use api-staging.balebase.com.",
    ],
    [
      "VITE_APP_URL",
      "http://app-staging.balebase.com",
      "VITE_APP_URL must use HTTPS for a store release.",
    ],
    ["VITE_API_URL", "https://localhost:8787", "uses host localhost."],
  ] as const) {
    test(`a staging release refuses ${name}=${url} before building`, async () => {
      const { exitCode, stderr, calls } = await runWrapper(
        "buildAndroidStagingRelease.sh",
        ["android", "build", "staging"],
        { [name]: url },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain(message);
      expect(calls).toEqual([]);
    });
  }

  test("an unknown target is rejected, even with --help", async () => {
    for (const extra of [[], ["--help"]]) {
      const { exitCode, stderr } = await runShell(
        '. "$1"; shift; native_release_main desktop build staging "$@"',
        ["sh", nativeReleaseScript, ...extra],
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "invalid native release target desktop:build:staging",
      );
    }
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
