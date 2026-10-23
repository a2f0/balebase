import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const dsn = `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1`;
const record = `import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const log = (value) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + "\\n");`;

async function releaseFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "balebase-release-orchestration-")),
  );
  for (const file of [
    "scripts/deploy/buildSentryApp.ts",
    "scripts/deploy/deploySentryApi.ts",
    "scripts/lib/sentryRelease.ts",
    "packages/diagnostics/src/config.ts",
  ]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(join(repo, file), join(root, file));
  }
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/git"),
    `#!/bin/sh\ncase "$1" in\nrev-parse) echo ${"b".repeat(40)};;\nstatus) exit 0;;\n*) exit 1;;\nesac\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "release-fixture",
      dependencies: { "@sentry/cli": "0.0.0", wrangler: "0.0.0" },
    }),
  );
  for (const target of ["app-web", "app-capacitor", "api"]) {
    await mkdir(join(root, "packages", target), { recursive: true });
    await writeFile(
      join(root, "packages", target, "package.json"),
      JSON.stringify({ scripts: { build: "bun ../../build.ts" } }),
    );
  }
  await writeFile(
    join(root, "build.ts"),
    `${record}
    log({ tool: "build", token: process.env.SENTRY_AUTH_TOKEN ?? null, tier: process.env.VITE_RELEASE_TIER ?? null });
    const build = JSON.parse(process.env.SENTRY_BUILD_CONFIG);
    mkdirSync("dist/assets", { recursive: true });
    writeFileSync("dist/assets/index-hash.js", "exact application bundle");
    if (process.env.FIXTURE_MISSING_MAP !== "1") writeFileSync("dist/assets/index-hash.js.map", "{}");
    writeFileSync("dist/sentry-assets.json", JSON.stringify({ ...build, paths: ["/assets/index-hash.js"] }));
  `,
  );
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  for (const [name, binary] of [
    ["@sentry/cli", "sentry-cli"],
    ["wrangler", "wrangler"],
  ] as const) {
    const packageDir = join(root, "node_modules", name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", bin: { [binary]: "index.ts" } }),
    );
    await writeFile(
      join(packageDir, "index.ts"),
      `#!${process.execPath}\n${record}
      const args = process.argv.slice(2);
      log({ tool: ${JSON.stringify(binary)}, args });
      if (${JSON.stringify(binary)} === "sentry-cli") process.exit(process.env.FIXTURE_UPLOAD_FAIL === "1" ? 1 : 0);
      if (args.includes("--outdir")) {
        const out = args[args.indexOf("--outdir") + 1];
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "index.js"), "exact API bundle");
        if (args.includes("--upload-source-maps")) writeFileSync(join(out, "index.js.map"), "{}");
      }
      if (args.includes("--no-bundle")) log({ tool: "published", contents: readFileSync(args.find((arg) => arg.endsWith("/index.js")), "utf8") });
    `,
      { mode: 0o755 },
    );
    await symlink(
      join(packageDir, "index.ts"),
      join(root, "node_modules/.bin", binary),
    );
  }
  return root;
}

interface Command {
  tool: string;
  args?: string[];
  token?: string | null;
  tier?: string | null;
  contents?: string;
}
async function runRelease(
  root: string,
  script: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  const { PATH } = process.env;
  const env = {
    ...process.env,
    PATH: `${root}/bin:${PATH}`,
    FIXTURE_LOG: join(root, "commands.jsonl"),
    SENTRY_ORG: "tearleads",
    SENTRY_AUTH_TOKEN: "fixture-token",
    SENTRY_STAGING_DSN: dsn,
    SENTRY_STAGING_PROJECT: "balebase-web-staging",
    SENTRY_API_STAGING_DSN: dsn,
    SENTRY_API_STAGING_PROJECT: "balebase-api-staging",
    DRY_RUN: "0",
    CLOUDFLARE_API_TOKEN: "",
    ...extra,
  };
  const child = Bun.spawn(
    [process.execPath, join(root, "scripts/deploy", script), ...args],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const text = await readFile(env.FIXTURE_LOG, "utf8").catch(() => "");
  return {
    code,
    output: stdout + stderr,
    commands: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Command),
  };
}

for (const fail of [false, true])
  test(`web release strips credentials and removes maps after upload ${fail ? "failure" : "success"}`, async () => {
    const root = await releaseFixture();
    try {
      const result = await runRelease(
        root,
        "buildSentryApp.ts",
        ["web", "staging"],
        { FIXTURE_UPLOAD_FAIL: fail ? "1" : "0" },
      );
      expect(result.code, result.output).toBe(fail ? 1 : 0);
      expect(result.commands.map((command) => command.tool)).toEqual([
        "build",
        "sentry-cli",
      ]);
      expect(result.commands[0]?.token).toBeNull();
      // Search indexing follows the release environment, here staging.
      expect(result.commands[0]?.tier).toBe("staging");
      expect(
        await Bun.file(
          join(root, "packages/app-web/dist/assets/index-hash.js.map"),
        ).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("web dry runs validate maps without uploading, and preflight never builds", async () => {
  const root = await releaseFixture();
  try {
    const preflight = await runRelease(root, "buildSentryApp.ts", [
      "web",
      "staging",
      "--check",
    ]);
    expect(preflight.code, preflight.output).toBe(0);
    expect(preflight.commands).toEqual([]);
    const dry = await runRelease(
      root,
      "buildSentryApp.ts",
      ["web", "staging"],
      { DRY_RUN: "1" },
    );
    expect(dry.code, dry.output).toBe(0);
    expect(dry.commands.map((command) => command.tool)).toEqual(["build"]);
    const missing = await runRelease(
      root,
      "buildSentryApp.ts",
      ["web", "staging"],
      { DRY_RUN: "1", FIXTURE_MISSING_MAP: "1" },
    );
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Missing source map");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const dryRun of ["0", "1"])
  test(`API orchestration selects staging and reuses the exact bundle (dry run ${dryRun})`, async () => {
    const root = await releaseFixture();
    try {
      const preflight = await runRelease(root, "deploySentryApi.ts", [
        "staging",
        "--check",
      ]);
      expect(preflight.code, preflight.output).toBe(0);
      expect(preflight.commands).toEqual([]);
      const result = await runRelease(root, "deploySentryApi.ts", ["staging"], {
        DRY_RUN: dryRun,
      });
      expect(result.code, result.output).toBe(0);
      expect(
        result.commands.filter((command) => command.tool === "sentry-cli"),
      ).toHaveLength(dryRun === "1" ? 0 : 1);
      const wrangler = result.commands.filter(
        (command) => command.tool === "wrangler",
      );
      expect(wrangler).toHaveLength(2);
      expect(wrangler[0]?.args).toContain(
        join(root, "packages/api/wrangler.staging.jsonc"),
      );
      expect(wrangler[0]?.args).toContain("--upload-source-maps");
      expect(wrangler[1]?.args).toContain("--no-bundle");
      expect(wrangler[1]?.args?.includes("--dry-run")).toBe(dryRun === "1");
      expect(result.commands.at(-1)).toEqual({
        tool: "published",
        contents: "exact API bundle",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("failed API map uploads stop before publishing", async () => {
  const root = await releaseFixture();
  try {
    const result = await runRelease(root, "deploySentryApi.ts", ["staging"], {
      FIXTURE_UPLOAD_FAIL: "1",
    });
    expect(result.code).toBe(1);
    expect(result.commands.map((command) => command.tool)).toEqual([
      "wrangler",
      "sentry-cli",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
