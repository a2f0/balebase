import { describe, expect, test } from "bun:test";
import {
  readNativeReleaseEnvironment,
  stagingTarget,
} from "./support/nativeReleaseSnapshot";

describe("native release environments", () => {
  test("staging imports only store names and defaults the bundle to its hosts", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "APP_STORE_CONNECT_KEY_ID=shared-key\nMATCH_PASSWORD=shared-match\nTEAM_ID=shared-team\nNATIVE_TEST_VALUE=shared\n",
      "ANDROID_KEYSTORE_STORE_PASS=staging-store\nANDROID_KEYSTORE_KEY_PASS=staging-key\nMATCH_PASSWORD=staging-match\nSERVER_SECRET=server-secret\n",
    );

    expect(snapshot).toEqual({
      ...stagingTarget,
      environment: {
        ANDROID_KEYSTORE_KEY_PASS: "staging-key",
        ANDROID_KEYSTORE_STORE_PASS: "staging-store",
        APP_STORE_CONNECT_KEY_ID: "shared-key",
        MATCH_PASSWORD: "staging-match",
        NATIVE_TEST_VALUE: null,
        SERVER_SECRET: null,
        TEAM_ID: "shared-team",
        VITE_API_URL: "https://api-staging.balebase.com",
        VITE_APP_URL: "https://app-staging.balebase.com",
      },
    });
  });

  test("explicit native release environment values beat dotenv files", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "APP_STORE_CONNECT_KEY_ID=shared-key\nTEAM_ID=shared-team\n",
      "ANDROID_KEYSTORE_STORE_PASS=staging-store\nANDROID_KEYSTORE_KEY_PASS=staging-key\n",
      {
        ANDROID_KEYSTORE_STORE_PASS: "process-store",
        APP_STORE_CONNECT_KEY_ID: "process-key",
        NATIVE_TEST_VALUE: "process",
        VITE_API_URL: "https://api-staging.balebase.com/",
      },
    );

    expect(snapshot.environment).toEqual({
      ANDROID_KEYSTORE_KEY_PASS: "staging-key",
      ANDROID_KEYSTORE_STORE_PASS: "process-store",
      APP_STORE_CONNECT_KEY_ID: "process-key",
      MATCH_PASSWORD: null,
      NATIVE_TEST_VALUE: "process",
      SERVER_SECRET: null,
      TEAM_ID: "shared-team",
      VITE_API_URL: "https://api-staging.balebase.com/",
      VITE_APP_URL: "https://app-staging.balebase.com",
    });
  });

  test("production keeps its default target and release environment", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "TEAM_ID=root\nNATIVE_TEST_VALUE=root\n",
      "ANDROID_KEYSTORE_STORE_PASS=staging-store\n",
      {},
      null,
    );

    expect(snapshot).toEqual({
      androidBuildVariant: "release",
      androidBuildVariantTask: "Release",
      appIdentifier: "com.balebase.app",
      iosArchiveRelativePath: "output/Balebase.xcarchive",
      releaseAabRelativePath: "bundle/release/app-release.aab",
      releaseMappingRelativePath: "mapping/release/mapping.txt",
      releaseNativeDebugSymbolsRelativePath:
        "native-debug-symbols/release/native-debug-symbols.zip",
      environment: {
        ANDROID_KEYSTORE_KEY_PASS: null,
        ANDROID_KEYSTORE_STORE_PASS: null,
        APP_STORE_CONNECT_KEY_ID: null,
        MATCH_PASSWORD: null,
        NATIVE_TEST_VALUE: null,
        SERVER_SECRET: null,
        TEAM_ID: "root",
        VITE_API_URL: "https://api.balebase.com",
        VITE_APP_URL: "https://app.balebase.com",
      },
      iosConfiguration: "Release",
      iosScheme: "App",
    });
  });

  test("each tier reads its own secrets folder", async () => {
    const stagingShared = "TEAM_ID=staging-shared\n";
    const prodShared = "TEAM_ID=prod-shared\n";
    const stagingApp = "ANDROID_KEYSTORE_STORE_PASS=staging-store\n";
    const staging = await readNativeReleaseEnvironment(
      stagingShared,
      stagingApp,
      {},
      "staging",
      prodShared,
    );
    expect(staging.environment).toMatchObject({
      ANDROID_KEYSTORE_STORE_PASS: "staging-store",
      TEAM_ID: "staging-shared",
    });

    const production = await readNativeReleaseEnvironment(
      stagingShared,
      stagingApp,
      {},
      "production",
      prodShared,
    );
    expect(production.environment).toMatchObject({
      ANDROID_KEYSTORE_STORE_PASS: null,
      NATIVE_TEST_VALUE: null,
      SERVER_SECRET: null,
      TEAM_ID: "prod-shared",
    });
  });

  // Both tiers apply the same rules, each to its own hosts.
  for (const [tier, own, other] of [
    ["production", "", "-staging"],
    ["staging", "-staging", ""],
  ] as const) {
    test(`validates ${tier} service URLs after dotenv and explicit values resolve`, async () => {
      const read = (environment: Record<string, string>) =>
        readNativeReleaseEnvironment("", "", environment, tier);

      await expect(
        read({
          VITE_API_URL: `https://API${own}.balebase.com./v1`,
          VITE_APP_URL: `https://app${own}.balebase.com`,
        }),
      ).resolves.toMatchObject({
        environment: {
          VITE_API_URL: `https://API${own}.balebase.com./v1`,
          VITE_APP_URL: `https://app${own}.balebase.com`,
        },
      });

      for (const [environment, message] of [
        [
          { VITE_API_URL: `https://api${other}.balebase.com` },
          `VITE_API_URL must use api${own}.balebase.com for a ${tier} release.`,
        ],
        [
          { VITE_APP_URL: `https://app${other}.balebase.com` },
          `VITE_APP_URL must use app${own}.balebase.com for a ${tier} release.`,
        ],
        [
          { VITE_API_URL: "https://localhost:8787" },
          `VITE_API_URL must use api${own}.balebase.com for a ${tier} release.`,
        ],
        [
          { VITE_APP_URL: `http://app${own}.balebase.com` },
          "VITE_APP_URL must use the https scheme.",
        ],
        [
          { VITE_API_URL: "https://" },
          "VITE_API_URL must be an absolute URL with a host.",
        ],
      ] as const) {
        await expect(read(environment)).rejects.toThrow(message);
      }
    });
  }
});
