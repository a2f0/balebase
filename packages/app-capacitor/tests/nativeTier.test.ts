import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const { scripts } = (await Bun.file(
  resolve(packageRoot, "package.json"),
).json()) as {
  scripts: Record<string, string>;
};

/**
 * Evaluates `script` in a fresh Bun process for the tier, from an empty
 * directory so no .env file applies, and returns the JSON it prints.
 */
async function evaluateForTier(script: string, tier: string | undefined) {
  const env = { ...process.env };
  for (const name of ["NATIVE_RELEASE_TIER", "VITE_API_URL", "VITE_APP_URL"]) {
    Reflect.deleteProperty(env, name);
  }
  if (tier !== undefined) Reflect.set(env, "NATIVE_RELEASE_TIER", tier);
  const cwd = await mkdtemp(join(tmpdir(), "balebase-native-tier-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stderr,
      value: exitCode === 0 ? JSON.parse(stdout) : null,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const capacitorIdentity = (tier: string | undefined) =>
  evaluateForTier(
    `const { default: c } = await import(${JSON.stringify(resolve(packageRoot, "capacitor.config.ts"))}); console.log(JSON.stringify([c.appId, c.appName]));`,
    tier,
  );

const viteBundleUrls = (tier: string | undefined) =>
  evaluateForTier(
    `const { default: c } = await import(${JSON.stringify(resolve(packageRoot, "vite.config.ts"))}); const { define } = await c({ command: "build", mode: "production" }); console.log(JSON.stringify(define));`,
    tier,
  );

// Each tier's expected identity and hosts, written out rather than read from
// nativeReleaseTargets.json so a changed value fails here.
const tiers = {
  production: {
    identity: ["com.balebase.app", "Balebase"],
    api: "https://api.balebase.com",
    app: "https://app.balebase.com",
  },
  staging: {
    identity: ["com.balebase.staging.app", "Balebase Staging"],
    api: "https://api-staging.balebase.com",
    app: "https://app-staging.balebase.com",
  },
};

test("the release tiers are production, the default, and staging", async () => {
  const targets = await Bun.file(
    resolve(packageRoot, "nativeReleaseTargets.json"),
  ).json();
  expect(targets.defaultTier).toBe("production");
  expect(Object.keys(targets.tiers)).toEqual(Object.keys(tiers));
});

for (const [tier, expected] of Object.entries(tiers)) {
  test(`the Capacitor and Vite configs follow the ${tier} tier`, async () => {
    // Production is also the tier without NATIVE_RELEASE_TIER.
    const spellings: (string | undefined)[] = [tier, ` ${tier.toUpperCase()} `];
    if (tier === "production") spellings.push(undefined);
    for (const spelling of spellings) {
      expect((await capacitorIdentity(spelling)).value).toEqual(
        expected.identity,
      );
      expect((await viteBundleUrls(spelling)).value).toEqual({
        "import.meta.env.VITE_API_URL": JSON.stringify(expected.api),
        "import.meta.env.VITE_APP_URL": JSON.stringify(expected.app),
      });
    }
  });
}

test("both configs reject an unknown tier with the same message", async () => {
  for (const evaluate of [capacitorIdentity, viteBundleUrls]) {
    const unknown = await evaluate("preview");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain(
      'Unknown NATIVE_RELEASE_TIER="preview". Expected production or staging.',
    );
  }
});

test("local build, sync, open, and run commands follow the caller's tier", () => {
  for (const name of [
    "build",
    "cap:sync",
    "cap:sync:debug",
    "cap:open:android",
    "cap:open:ios",
    "cap:run:android",
    "cap:run:ios",
  ]) {
    expect(scripts[name], name).not.toContain("NATIVE_RELEASE_TIER=");
  }
});

const fastlaneScripts = Object.entries(scripts).filter(([, command]) =>
  command.includes("bundle exec fastlane "),
);

test("release commands pin the tier their name selects", () => {
  const tierScripts = Object.entries(scripts).filter(
    ([name, command]) =>
      command.includes("bundle exec fastlane ") ||
      name === "cap:sync:release" ||
      name === "cap:sync:staging",
  );
  expect(tierScripts.length).toBeGreaterThan(2);
  for (const [name, command] of tierScripts) {
    const tier = name.endsWith(":staging") ? "staging" : "production";
    expect(command, name).toContain(`NATIVE_RELEASE_TIER=${tier} `);
  }
});

test("each lane script is named <platform>:<lane in kebab case>", () => {
  expect(fastlaneScripts.length).toBeGreaterThan(0);
  for (const [name, command] of fastlaneScripts) {
    const match = /bundle exec fastlane (?:(android|ios) )?([a-z_]+)$/.exec(
      command,
    );
    expect(match, name).not.toBeNull();
    const [, platform, lane = ""] = match ?? [];
    const expected = platform
      ? `${platform}:${lane.replaceAll("_", "-")}`
      : lane.replace(/^store_/, "store:").replaceAll("_", "-");
    expect(name.replace(/:staging$/, ""), command).toBe(expected);
  }
});
