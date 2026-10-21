import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRubyBundle } from "./requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "..");
const nativeReleaseTargetPath = resolve(
  packageRoot,
  "fastlane/lib/native_release_target.rb",
);
const snapshotScriptPath = resolve(
  import.meta.dir,
  "native_release_snapshot.rb",
);

const targets = {
  production: {
    androidBuildVariant: "release",
    androidBuildVariantTask: "Release",
    appIdentifier: "com.balebase.app",
    iosArchiveRelativePath: "output/Balebase.xcarchive",
    iosConfiguration: "Release",
    iosScheme: "App",
    releaseAabRelativePath: "bundle/release/app-release.aab",
  },
  staging: {
    androidBuildVariant: "staging",
    androidBuildVariantTask: "Staging",
    appIdentifier: "com.balebase.staging.app",
    iosArchiveRelativePath: "output/staging/Balebase-Staging.xcarchive",
    iosConfiguration: "Release-Staging",
    iosScheme: "App-Staging",
    releaseAabRelativePath: "bundle/staging/app-staging.aab",
  },
};

const releaseNames = [
  "APP_STORE_CONNECT_KEY_ID",
  "BALEBASE_ANDROID_KEYSTORE_PASS",
  "NATIVE_RELEASE_TIER",
  "SERVER_SECRET",
  "VITE_API_URL",
  "VITE_APP_URL",
];

// app.env also carries the tier's server secrets, which a native release
// must never import.
const appEnv = (tier: string) =>
  `SERVER_SECRET=${tier}-server\nBALEBASE_ANDROID_KEYSTORE_PASS=${tier}-keystore\nVITE_API_URL=https://app-env.example\n`;

/** Runs native_release_target.rb from a copy whose .secrets are fixtures. */
async function loadRelease(
  tier: "production" | "staging",
  sharedEnv: string,
  processEnvironment: Record<string, string> = {},
) {
  await requireRubyBundle();
  const root = await mkdtemp(join(tmpdir(), "balebase-native-release-"));
  const copiedTarget = join(
    root,
    "packages/app-capacitor/fastlane/lib/native_release_target.rb",
  );
  await mkdir(resolve(copiedTarget, ".."), { recursive: true });
  await Promise.all([
    Bun.write(copiedTarget, Bun.file(nativeReleaseTargetPath)),
    ...["prod", "staging"].flatMap((secrets) => [
      Bun.write(join(root, ".secrets", secrets, "app.env"), appEnv(secrets)),
      Bun.write(join(root, ".secrets", secrets, "shared.env"), sharedEnv),
    ]),
  ]);
  const environment = { ...process.env };
  for (const name of releaseNames) Reflect.deleteProperty(environment, name);
  Object.assign(environment, processEnvironment, { NATIVE_RELEASE_TIER: tier });
  try {
    const child = Bun.spawn(
      ["bundle", "exec", "ruby", snapshotScriptPath, copiedTarget],
      { cwd: packageRoot, env: environment, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return {
      exitCode,
      stderr,
      snapshot: exitCode === 0 ? JSON.parse(stdout) : null,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("native release environments", () => {
  for (const [tier, secrets, apiHost, appHost] of [
    ["production", "prod", "api.balebase.com", "app.balebase.com"],
    [
      "staging",
      "staging",
      "api-staging.balebase.com",
      "app-staging.balebase.com",
    ],
  ] as const) {
    test(`${tier} reads its own store values and only the keystore password from app.env`, async () => {
      const { exitCode, stderr, snapshot } = await loadRelease(
        tier,
        "APP_STORE_CONNECT_KEY_ID=shared-key\nVITE_APP_URL=https://shared.example\n",
      );
      expect(exitCode, stderr).toBe(0);
      expect(snapshot).toEqual({
        ...targets[tier],
        environment: {
          APP_STORE_CONNECT_KEY_ID: "shared-key",
          BALEBASE_ANDROID_KEYSTORE_PASS: `${secrets}-keystore`,
          SERVER_SECRET: null,
          VITE_API_URL: `https://${apiHost}`,
          VITE_APP_URL: `https://${appHost}`,
        },
      });
      expect(stderr).toContain(
        `Ignoring ${secrets}/shared.env Vite settings for a native release: VITE_APP_URL`,
      );
    });
  }

  test("explicit environment values beat the secrets files", async () => {
    const { exitCode, stderr, snapshot } = await loadRelease(
      "staging",
      "APP_STORE_CONNECT_KEY_ID=shared-key\n",
      {
        APP_STORE_CONNECT_KEY_ID: "process-key",
        BALEBASE_ANDROID_KEYSTORE_PASS: "process-keystore",
        VITE_API_URL: "https://api-staging.balebase.com/",
      },
    );
    expect(exitCode, stderr).toBe(0);
    expect(snapshot?.environment).toMatchObject({
      APP_STORE_CONNECT_KEY_ID: "process-key",
      BALEBASE_ANDROID_KEYSTORE_PASS: "process-keystore",
      VITE_API_URL: "https://api-staging.balebase.com/",
    });
  });

  for (const [name, url, problem] of [
    [
      "VITE_API_URL",
      "https://api.balebase.com",
      "must use api-staging.balebase.com for a staging release",
    ],
    [
      "VITE_APP_URL",
      "http://app-staging.balebase.com",
      "must use the https scheme",
    ],
    ["VITE_API_URL", "https://", "must be an absolute URL with a host"],
  ] as const) {
    test(`a staging release rejects ${name}=${url}`, async () => {
      const { exitCode, stderr } = await loadRelease("staging", "", {
        [name]: url,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`${name} ${problem}.`);
    });
  }
});
