import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { requireRubyBundle } from "./support/requireRubyBundle";

const packageRoot = resolve(import.meta.dir, "../..");
const nativeReleaseTargetPath = resolve(
  packageRoot,
  "fastlane/lib/native_release_target.rb",
);
const snapshotScriptPath = resolve(
  import.meta.dir,
  "support/native_release_snapshot.rb",
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
  "ANDROID_KEYSTORE_KEY_PASS",
  "ANDROID_KEYSTORE_STORE_PASS",
  "APP_STORE_CONNECT_KEY_ID",
  "MATCH_PASSWORD",
  "NATIVE_RELEASE_SECRETS_DIR",
  "NATIVE_RELEASE_TIER",
  "SERVER_SECRET",
  "SHARED_SERVER_SECRET",
  "VITE_API_URL",
  "VITE_APP_URL",
];

// Both secrets files also carry values a native release must never import:
// the tier's server secrets in app.env and account-level values in shared.env.
// A store value rotated into app.env overrides its shared.env copy.
const appEnv = (tier: string) =>
  [
    `SERVER_SECRET=${tier}-server`,
    `ANDROID_KEYSTORE_STORE_PASS=${tier}-store`,
    `ANDROID_KEYSTORE_KEY_PASS=${tier}-key`,
    `MATCH_PASSWORD=${tier}-app-match`,
    "VITE_API_URL=https://app-env.example",
    "",
  ].join("\n");

type Snapshot = {
  secretsDir: string;
  environment: Record<string, string | null>;
} & Record<string, unknown>;

/**
 * Loads native_release_target.rb with NATIVE_RELEASE_SECRETS_DIR naming a
 * fixture folder, given relative to this package when `relativeOverride` is set.
 */
async function loadRelease(
  tier: "production" | "staging",
  sharedEnv: string,
  processEnvironment: Record<string, string> = {},
  relativeOverride = false,
) {
  await requireRubyBundle();
  const root = await mkdtemp(join(tmpdir(), "balebase-native-release-"));
  const secretsDir = join(root, tier === "staging" ? "staging" : "prod");
  await Promise.all([
    Bun.write(join(secretsDir, "app.env"), appEnv(tier)),
    Bun.write(join(secretsDir, "shared.env"), sharedEnv),
  ]);
  const environment = { ...process.env };
  for (const name of releaseNames) Reflect.deleteProperty(environment, name);
  Object.assign(environment, processEnvironment, {
    NATIVE_RELEASE_SECRETS_DIR: relativeOverride
      ? relative(packageRoot, secretsDir)
      : secretsDir,
    NATIVE_RELEASE_TIER: tier,
  });
  try {
    const child = Bun.spawn(
      ["bundle", "exec", "ruby", snapshotScriptPath, nativeReleaseTargetPath],
      { cwd: packageRoot, env: environment, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return {
      exitCode,
      secretsDir,
      stderr,
      snapshot: exitCode === 0 ? (JSON.parse(stdout) as Snapshot) : null,
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
    test(`${tier} imports only the release names from shared.env and app.env`, async () => {
      const { exitCode, secretsDir, stderr, snapshot } = await loadRelease(
        tier,
        "APP_STORE_CONNECT_KEY_ID=shared-key\nMATCH_PASSWORD=shared-match\nSHARED_SERVER_SECRET=shared-server\nVITE_APP_URL=https://shared.example\n",
      );
      expect(exitCode, stderr).toBe(0);
      expect(snapshot).toEqual({
        ...targets[tier],
        secretsDir,
        environment: {
          ANDROID_KEYSTORE_KEY_PASS: `${tier}-key`,
          ANDROID_KEYSTORE_STORE_PASS: `${tier}-store`,
          APP_STORE_CONNECT_KEY_ID: "shared-key",
          MATCH_PASSWORD: `${tier}-app-match`,
          SERVER_SECRET: null,
          SHARED_SERVER_SECRET: null,
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
        ANDROID_KEYSTORE_STORE_PASS: "process-store",
        VITE_API_URL: "https://api-staging.balebase.com/",
      },
    );
    expect(exitCode, stderr).toBe(0);
    expect(snapshot?.environment).toMatchObject({
      APP_STORE_CONNECT_KEY_ID: "process-key",
      ANDROID_KEYSTORE_STORE_PASS: "process-store",
      ANDROID_KEYSTORE_KEY_PASS: "staging-key",
      VITE_API_URL: "https://api-staging.balebase.com/",
    });
  });

  test("a relative NATIVE_RELEASE_SECRETS_DIR resolves against the package", async () => {
    const { exitCode, secretsDir, stderr, snapshot } = await loadRelease(
      "staging",
      "",
      {},
      true,
    );
    expect(exitCode, stderr).toBe(0);
    expect(snapshot?.secretsDir).toBe(secretsDir);
    expect(snapshot?.environment).toMatchObject({
      ANDROID_KEYSTORE_STORE_PASS: "staging-store",
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
