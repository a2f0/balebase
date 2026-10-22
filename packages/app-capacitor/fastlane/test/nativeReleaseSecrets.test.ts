import { describe, expect, test } from "bun:test";
import {
  readNativeReleaseEnvironment,
  readNativeReleaseEnvironmentResult,
} from "./support/nativeReleaseSnapshot";

// Both files also hold server values; only store names may reach the lanes.
const sharedEnv =
  "TEAM_ID=shared-team\nANDROID_KEYSTORE_STORE_PASS=shared-pass\nSERVER_SECRET=shared-server\nNATIVE_TEST_VALUE=shared\n";
const appEnv =
  "ANDROID_KEYSTORE_STORE_PASS=app-pass\nSERVER_SECRET=app-server\nNATIVE_TEST_VALUE=app\n";
const storeEnvironment = {
  ANDROID_KEYSTORE_STORE_PASS: "app-pass",
  NATIVE_TEST_VALUE: null,
  SERVER_SECRET: null,
  TEAM_ID: "shared-team",
};

describe("native release secrets", () => {
  test("production imports store names from shared.env, then app.env", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "",
      "",
      {},
      "production",
      sharedEnv,
      { ".secrets/prod/app.env": appEnv },
    );

    expect(snapshot.environment).toMatchObject(storeEnvironment);
  });

  test("staging imports store names from shared.env, then app.env", async () => {
    const snapshot = await readNativeReleaseEnvironment(sharedEnv, appEnv);

    expect(snapshot.environment).toMatchObject(storeEnvironment);
  });

  test("production ignores Vite settings in both secrets files", async () => {
    const result = await readNativeReleaseEnvironmentResult(
      "",
      "",
      {},
      "production",
      "VITE_APP_URL=https://shared.example\n",
      { ".secrets/prod/app.env": "VITE_API_URL=https://app.example\n" },
    );

    expect(result.snapshot.environment).toMatchObject({
      VITE_API_URL: "https://api.balebase.com",
      VITE_APP_URL: "https://app.balebase.com",
    });
    expect(result.stderr).toContain(
      "Ignoring prod/shared.env Vite settings for production: VITE_APP_URL",
    );
    expect(result.stderr).toContain(
      "Ignoring prod/app.env Vite settings for production: VITE_API_URL",
    );
  });

  test("NATIVE_RELEASE_SECRETS_DIR replaces the staging secrets folder", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "TEAM_ID=tier-team\n",
      "ANDROID_KEYSTORE_STORE_PASS=tier-pass\n",
      { NATIVE_RELEASE_SECRETS_DIR: "override" },
      "staging",
      "TEAM_ID=prod-team\n",
      {
        "packages/app-capacitor/override/shared.env": "TEAM_ID=override-team\n",
        "packages/app-capacitor/override/app.env":
          "ANDROID_KEYSTORE_STORE_PASS=override-pass\n",
      },
    );

    expect(snapshot.environment).toMatchObject({
      ANDROID_KEYSTORE_STORE_PASS: "override-pass",
      TEAM_ID: "override-team",
    });
  });

  test("NATIVE_RELEASE_SECRETS_DIR replaces the production secrets folder", async () => {
    const snapshot = await readNativeReleaseEnvironment(
      "",
      "",
      { NATIVE_RELEASE_SECRETS_DIR: "override" },
      "production",
      "TEAM_ID=prod-team\nANDROID_KEYSTORE_STORE_PASS=prod-pass\n",
      {
        "packages/app-capacitor/override/shared.env": "TEAM_ID=override-team\n",
      },
    );

    expect(snapshot.environment).toMatchObject({
      ANDROID_KEYSTORE_STORE_PASS: null,
      TEAM_ID: "override-team",
    });
  });
});
