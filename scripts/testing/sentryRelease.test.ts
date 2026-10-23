import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseConfiguration, removeSourceMaps } from "../lib/sentryRelease";

test("release selection isolates platform and tier and fails closed on configuration mistakes", () => {
  const dsn = `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1`;
  const commit = "b".repeat(40);
  const env = {
    SENTRY_PRODUCTION_DSN: dsn,
    SENTRY_PRODUCTION_PROJECT: "balebase-web-production",
    SENTRY_ANDROID_STAGING_DSN: dsn,
    SENTRY_ANDROID_STAGING_PROJECT: "balebase-android-staging",
  };
  expect(
    releaseConfiguration("web", "production", env, commit)?.build,
  ).toMatchObject({
    target: "web",
    environment: "production",
    release: `balebase-web@${commit}`,
  });
  expect(releaseConfiguration("android", "staging", env, commit)?.project).toBe(
    "balebase-android-staging",
  );
  expect(releaseConfiguration("web", "staging", env, commit)).toBeUndefined();
  expect(releaseConfiguration("ios", "staging", env, commit)).toBeUndefined();
  expect(() =>
    releaseConfiguration(
      "web",
      "production",
      { ...env, SENTRY_PRODUCTION_PROJECT: "balebase-web-staging" },
      commit,
    ),
  ).toThrow("Expected");
  expect(() =>
    releaseConfiguration("web", "development", env, commit),
  ).toThrow();
  expect(() =>
    releaseConfiguration("web", "production", env, "dirty"),
  ).toThrow();
});

test("source maps are removed recursively without changing bundles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balebase-maps-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "assets/index.js"), "bundle");
    await writeFile(join(directory, "assets/index.js.map"), "sources");
    await removeSourceMaps(directory);
    expect(await readFile(join(directory, "assets/index.js"), "utf8")).toBe(
      "bundle",
    );
    expect(
      await Bun.file(join(directory, "assets/index.js.map")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
