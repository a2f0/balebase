import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareStagingFrontends } from "../deploy/prepareStagingFrontends";

const roots: string[] = [];
const domains = [
  { hostname: "app-staging.balebase.com", service: "balebase-client-staging" },
  {
    hostname: "website-staging.balebase.com",
    service: "balebase-website-staging",
  },
];
const repo = resolve(import.meta.dir, "../..");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "balebase-staging-frontends-"));
  roots.push(root);
  for (const [pkg, name] of [
    ["app-web", "balebase-client"],
    ["website", "balebase-website"],
  ] as const) {
    await mkdir(join(root, "packages", pkg), { recursive: true });
    await writeFile(
      join(root, "packages", pkg, "wrangler.jsonc"),
      `{
      // JSONC comments and trailing commas are valid Wrangler configuration.
      "name": "${name}", "compatibility_date": "2026-08-17",
      "assets": { "directory": "./dist" },
    }`,
    );
    await writeFile(
      join(root, "packages", pkg, "wrangler.staging.jsonc"),
      "stale",
    );
  }
  return root;
}

test("frontend configs are refreshed from current JSONC for verified domains", async () => {
  const root = await fixture();
  await prepareStagingFrontends(root, domains);
  const app = await Bun.file(
    join(root, "packages/app-web/wrangler.staging.jsonc"),
  ).json();
  const site = await Bun.file(
    join(root, "packages/website/wrangler.staging.jsonc"),
  ).json();
  expect(app.name).toBe("balebase-client-staging");
  expect(site.name).toBe("balebase-website-staging");
  expect(app.assets).toEqual({ directory: "./dist" });
  expect(
    await Bun.file(join(root, "packages/api/wrangler.staging.jsonc")).exists(),
  ).toBe(false);
});

test("unexpected or missing domains and non-frontend bindings fail before writing", async () => {
  const root = await fixture();
  await expect(prepareStagingFrontends(root, [])).rejects.toThrow(
    "must already belong",
  );
  await expect(
    prepareStagingFrontends(
      root,
      domains.map((domain) => ({ ...domain, service: "production-worker" })),
    ),
  ).rejects.toThrow("must already belong");
  const file = join(root, "packages/app-web/wrangler.jsonc");
  await writeFile(
    file,
    JSON.stringify({
      name: "balebase-client",
      assets: { directory: "./dist" },
      d1_databases: [],
    }),
  );
  await expect(prepareStagingFrontends(root, domains)).rejects.toThrow(
    "asset-only",
  );
  expect(
    await readFile(
      join(root, "packages/website/wrangler.staging.jsonc"),
      "utf8",
    ),
  ).toBe("stale");
  await writeFile(
    file,
    JSON.stringify({ name: "wrong-worker", assets: { directory: "./dist" } }),
  );
  await expect(prepareStagingFrontends(root, domains)).rejects.toThrow(
    "asset-only",
  );
});

async function shellFixture() {
  const root = await fixture();
  for (const dir of [
    "scripts/deploy",
    "scripts/lib",
    ".secrets/staging",
    "bin",
  ])
    await mkdir(join(root, dir), { recursive: true });
  for (const script of [
    "deploy/deployStagingFrontends.sh",
    "lib/cloudflareEnv.sh",
  ])
    await copyFile(
      join(repo, "scripts", script),
      join(root, "scripts", script),
    );
  await writeFile(
    join(root, ".secrets/staging/app.env"),
    "TF_VAR_cloudflare_api_token=staging-fixture\nTF_VAR_cloudflare_account_id=staging-account\n",
  );
  await writeFile(
    join(root, "scripts/deploy/verifyStaging.sh"),
    'printf "verify\\n" >> "$MOCK_LOG"\n',
  );
  const stub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "scripts/deploy/prepareStagingFrontends.ts" && "\${MOCK_PREPARE_FAIL:-0}" == "1" ]]; then exit 1; fi
printf '%s %s token=%s api=%s website=%s app=%s\\n' "\${0##*/}" "$*" "$CLOUDFLARE_API_TOKEN" "\${VITE_API_URL:-}" "\${VITE_WEBSITE_URL:-}" "\${PUBLIC_APP_URL:-}" >> "$MOCK_LOG"
`;
  for (const executable of ["bun", "bunx"]) {
    await writeFile(join(root, "bin", executable), stub);
    await chmod(join(root, "bin", executable), 0o700);
  }
  return root;
}

async function runLane(root: string, dryRun: boolean, failPrepare = false) {
  const { PATH: executablePath } = process.env;
  const log = join(root, "commands.log");
  await writeFile(log, "");
  const child = Bun.spawn(
    ["/bin/bash", join(root, "scripts/deploy/deployStagingFrontends.sh")],
    {
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${executablePath}`,
        MOCK_LOG: log,
        DRY_RUN: dryRun ? "1" : "0",
        MOCK_PREPARE_FAIL: failPrepare ? "1" : "0",
        TF_VAR_cloudflare_api_token: "production-fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (!failPrepare && code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return { code, log: await readFile(log, "utf8") };
}

test("preview and deploy touch only the two staging frontends with staging settings", async () => {
  const root = await shellFixture();
  for (const dryRun of [true, false]) {
    const { code, log } = await runLane(root, dryRun);
    expect(code).toBe(0);
    expect(log.match(/bunx .*wrangler deploy/g)).toHaveLength(2);
    for (const pkg of ["app-web", "website"])
      expect(log).toContain(
        `--config ${root}/packages/${pkg}/wrangler.staging.jsonc${dryRun ? " --dry-run" : ""} token=staging-fixture`,
      );
    expect(log).toContain(
      "api=https://api-staging.balebase.com website=https://website-staging.balebase.com",
    );
    expect(log).toContain("app=https://app-staging.balebase.com");
    expect(log).not.toMatch(
      /production-fixture|migrations|secret put|terraform|packages\/api\//,
    );
    expect(log.includes("verify\n")).toBe(!dryRun);
  }
  const failed = await runLane(root, false, true);
  expect(failed.code).not.toBe(0);
  expect(failed.log).toBe("");
});
