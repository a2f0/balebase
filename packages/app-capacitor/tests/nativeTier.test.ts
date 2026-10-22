import { expect, test } from "bun:test";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const { scripts } = (await Bun.file(
  resolve(packageRoot, "package.json"),
).json()) as {
  scripts: Record<string, string>;
};

async function capacitorIdentity(tier: string | undefined) {
  const env = { ...process.env };
  Reflect.deleteProperty(env, "NATIVE_RELEASE_TIER");
  if (tier !== undefined) Reflect.set(env, "NATIVE_RELEASE_TIER", tier);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const { default: c } = await import("./capacitor.config.ts"); console.log(JSON.stringify([c.appId, c.appName]));',
    ],
    { cwd: packageRoot, env, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stderr,
    identity: exitCode === 0 ? JSON.parse(stdout) : null,
  };
}

test("the Capacitor config takes its store identity from the release tier", async () => {
  expect((await capacitorIdentity(undefined)).identity).toEqual([
    "com.balebase.app",
    "Balebase",
  ]);
  expect((await capacitorIdentity(" Staging ")).identity).toEqual([
    "com.balebase.staging.app",
    "Balebase Staging",
  ]);
  const unknown = await capacitorIdentity("preview");
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr).toContain('Unknown NATIVE_RELEASE_TIER="preview"');
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
