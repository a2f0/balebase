import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = await Bun.file(join(import.meta.dir, "../dev/scope.sh")).text();
const revision = script.match(/^scope_revision=([a-f0-9]+)$/m)?.[1] ?? "";
const { PATH: executablePath } = process.env;
let directory: string;
let source: string;
let env: Record<string, string | undefined> & {
  SCOPE_TEST_REVISION: string;
  SCOPE_CLAUDE_CREDENTIALS_FILE: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  SCOPE_SOURCE_DIR: string;
  SCOPE_INSTALL_DIR: string;
  SCOPE_TEST_DIRTY: string;
  SCOPE_TEST_PNPM_EXIT: string;
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "balebase-scope-"));
  source = join(directory, "scope source");
  await mkdir(join(directory, "scripts/dev"), { recursive: true });
  await mkdir(join(directory, ".scope"));
  await mkdir(join(directory, "bin"));
  await mkdir(join(source, "apps/cli/dist"), { recursive: true });
  await mkdir(join(source, ".git"));
  await writeFile(
    join(source, "apps/cli/dist/scope.mjs"),
    '#!/bin/sh\nprintf "fixture-scope\\n"\n',
  );
  await writeFile(join(directory, "scripts/dev/scope.sh"), script);
  const recorder = `#!/usr/bin/env bun
await Bun.write(process.env.SCOPE_TEST_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  url: process.env.SCOPE_API_URL,
}));
`;
  for (const command of ["docker", "node"]) {
    const path = join(directory, "bin", command);
    await writeFile(path, recorder);
    await chmod(path, 0o755);
  }
  const git = join(directory, "bin/git");
  await writeFile(
    git,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$SCOPE_TEST_GIT_LOG"
if [ "$1" = clone ]; then
  mkdir -p "$3/.git"
  printf '{}\\n' > "$3/package.json"
  exit
fi
case "$3" in
  rev-parse) printf '%s\\n' "$SCOPE_TEST_REVISION" ;;
  status) printf '%s' "$SCOPE_TEST_DIRTY" ;;
esac
`,
  );
  await chmod(git, 0o755);
  const pnpm = join(directory, "bin/pnpm");
  await writeFile(
    pnpm,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SCOPE_TEST_PNPM_LOG"\nexit "$SCOPE_TEST_PNPM_EXIT"\n',
  );
  await chmod(pnpm, 0o755);
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/^(SCOPE_|CLAUDE_CODE_|ANTHROPIC_)/.test(key)) delete inherited[key];
  }
  env = {
    ...inherited,
    PATH: `${join(directory, "bin")}:${executablePath}`,
    SCOPE_TEST_REVISION: revision,
    SCOPE_CLAUDE_CREDENTIALS_FILE: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    SCOPE_SOURCE_DIR: source,
    SCOPE_INSTALL_DIR: join(directory, "installed bin"),
    SCOPE_TEST_DIRTY: "",
    SCOPE_TEST_PNPM_EXIT: "0",
    SCOPE_TEST_RECORD: join(directory, "record.json"),
    SCOPE_TEST_GIT_LOG: join(directory, "git.log"),
    SCOPE_TEST_PNPM_LOG: join(directory, "pnpm.log"),
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function run(...args: string[]) {
  return Bun.spawnSync(["bash", "scripts/dev/scope.sh", ...args], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function record() {
  return (await Bun.file(join(directory, "record.json")).json()) as {
    args: string[];
    token?: string;
    url?: string;
  };
}

test("missing or mismatched installations stop before invoking tools", async () => {
  env.SCOPE_TEST_REVISION = "different-revision";
  expect(run("up").stderr.toString()).toContain("bun run scope:install");
  env.SCOPE_TEST_REVISION = revision;
  await rm(join(source, "apps/cli/dist/scope.mjs"));
  const result = run("--version");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("bun run scope:install");
  expect(await Bun.file(join(directory, "record.json")).exists()).toBe(false);
});

test("startup passes a valid login privately and preserves Compose arguments", async () => {
  env.SCOPE_CLAUDE_CREDENTIALS_FILE = join(directory, "login.json");
  await writeFile(
    env.SCOPE_CLAUDE_CREDENTIALS_FILE,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-token",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  const result = run("up", "--wait");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
    "fixture-token",
  );
  const saved = await record();
  expect(saved.token).toBe("fixture-token");
  expect(saved.args).toContain("balebase-scope");
  expect(saved.args).toContain("claude-code");
  expect(saved.args.slice(-4)).toEqual(["up", "--detach", "--build", "--wait"]);
});

test("missing, expired, or incomplete login files fail before startup", async () => {
  env.SCOPE_CLAUDE_CREDENTIALS_FILE = join(directory, "login.json");
  expect(run("up").stderr.toString()).toContain("claude setup-token");
  for (const expiresAt of [Date.now() - 1, Date.now() + 60_000, undefined]) {
    await writeFile(
      env.SCOPE_CLAUDE_CREDENTIALS_FILE,
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt } }),
    );
    const result = run("up");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refresh it with Claude Code");
  }
  expect(await Bun.file(join(directory, "record.json")).exists()).toBe(false);
});

test("an explicit token wins, and stopping never requires a valid login", async () => {
  env.SCOPE_CLAUDE_CREDENTIALS_FILE = join(directory, "missing.json");
  env.CLAUDE_CODE_OAUTH_TOKEN = "explicit-fixture-token";
  expect(run("up").exitCode).toBe(0);
  expect((await record()).token).toBe("explicit-fixture-token");
  env.CLAUDE_CODE_OAUTH_TOKEN = "";
  env.SCOPE_TEST_REVISION = "old-revision";
  await rm(join(source, "apps/cli/dist/scope.mjs"));
  expect(run("down").exitCode).toBe(0);
  expect((await record()).args.at(-1)).toBe("down");
  expect((await record()).args).not.toContain("--volumes");
});

test("an API key skips a stale login file, and dirty source blocks startup", async () => {
  env.SCOPE_CLAUDE_CREDENTIALS_FILE = join(directory, "missing.json");
  env.ANTHROPIC_API_KEY = "fixture-api-key";
  expect(run("up").exitCode).toBe(0);
  expect((await record()).token).toBe("");
  env.SCOPE_TEST_DIRTY = " M docker-compose.yml";
  expect(run("up").stderr.toString()).toContain(
    "Scope source has local changes",
  );
});

test("install builds matching source without fetching and installs the CLI", async () => {
  const result = run("install");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("fixture-scope");
  const commands = await Bun.file(join(directory, "git.log")).text();
  expect(commands).not.toContain("fetch");
  expect(commands).not.toContain("checkout");
  const builds = await Bun.file(join(directory, "pnpm.log")).text();
  expect(builds).toContain(
    "--filter cli... --filter portal... install --frozen-lockfile",
  );
  expect(builds).toContain("build:cli");
  expect(await Bun.file(join(env.SCOPE_INSTALL_DIR, "scope")).exists()).toBe(
    true,
  );
});

test("install fetches the pin for stale source and clones a missing checkout", async () => {
  env.SCOPE_TEST_REVISION = "old-revision";
  expect(run("install").exitCode).toBe(0);
  const commands = await Bun.file(join(directory, "git.log")).text();
  expect(commands).toContain(`fetch origin ${revision}`);
  expect(commands).toContain(`checkout --detach ${revision}`);
  await rm(join(source, ".git"), { recursive: true });
  expect(run("install").exitCode).toBe(0);
  expect(await Bun.file(join(directory, "git.log")).text()).toContain(
    "clone https://github.com/microsoft/scope.git",
  );
});

test("install keeps cloned manifests readable with a restrictive caller umask", async () => {
  await rm(join(source, ".git"), { recursive: true });
  const result = Bun.spawnSync(
    ["bash", "-c", "umask 077; exec bash scripts/dev/scope.sh install"],
    { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect((await stat(join(source, "package.json"))).mode & 0o777).toBe(0o644);
});

test("dirty source and failed builds preserve an existing installed CLI", async () => {
  await mkdir(env.SCOPE_INSTALL_DIR);
  const installed = join(env.SCOPE_INSTALL_DIR, "scope");
  await writeFile(installed, "existing CLI");
  env.SCOPE_TEST_DIRTY = " M apps/cli/src/index.ts";
  expect(run("install").exitCode).toBe(1);
  expect(await Bun.file(join(directory, "pnpm.log")).exists()).toBe(false);
  expect(await Bun.file(installed).text()).toBe("existing CLI");
  env.SCOPE_TEST_DIRTY = "";
  env.SCOPE_TEST_PNPM_EXIT = "1";
  expect(run("install").exitCode).toBe(1);
  expect(await Bun.file(installed).text()).toBe("existing CLI");
});

test("local configuration selects the source and API for CLI commands", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(directory, ".scope/local.env"),
    `SCOPE_SOURCE_DIR=${quote(source)}\nSCOPE_API_URL=http://127.0.0.1:3199\n`,
  );
  env.SCOPE_SOURCE_DIR = join(directory, "missing source");
  expect(run("project", "list", "-o", "json").exitCode).toBe(0);
  const saved = await record();
  expect(saved.url).toBe("http://127.0.0.1:3199");
  expect(saved.args).toEqual([
    join(source, "apps/cli/dist/scope.mjs"),
    "project",
    "list",
    "-o",
    "json",
  ]);
});

test("configuration-only startup reuses images without conflicting build flags", async () => {
  expect(run("up", "--no-build").exitCode).toBe(0);
  const args = (await record()).args;
  expect(args).toContain("--no-build");
  expect(args).not.toContain("--build");
});
