import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gitFixtureEnv } from "./gitFixture";

// These fixtures run this repository's committed pre-push hook, the pinned
// agent-tool push gate it calls, and the commit and branch policy from
// agent-tool.json, so they fail if the wiring or the policy stops refusing
// unsigned or attributed commits.
const root = resolve(import.meta.dir, "../..");
const cli = resolve(root, "node_modules/.bin/agent-tool");
const source = "scripts/git/hooks/pre-push";
const zero = "0".repeat(40);

interface Policy {
  branch: unknown;
  commits: { signatures: string; rejectCoauthors: boolean };
}

async function policy(): Promise<Policy> {
  return JSON.parse(await readFile(resolve(root, "agent-tool.json"), "utf8"));
}

function fixtureEnv() {
  return {
    ...gitFixtureEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runner(env: Record<string, string | undefined>) {
  const command = (cwd: string, args: string[], stdin?: string) =>
    Bun.spawnSync(args, {
      cwd,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  const git = (cwd: string, ...args: string[]) => {
    const result = command(cwd, ["git", ...args]);
    if (result.exitCode !== 0)
      throw new Error(result.stdout.toString() + result.stderr.toString());
    return result.stdout.toString().trim();
  };
  return { command, git };
}

/**
 * A repository with the committed hook installed, the pinned agent-tool
 * linked in as node_modules, and an agent-tool.json carrying this
 * repository's branch policy, the given commit policy, and the given steps.
 */
async function adoptGate(
  repository: string,
  commits: Policy["commits"],
  steps: { label: string; command: string[] }[],
) {
  const { branch } = await policy();
  await mkdir(resolve(repository, "scripts/git/hooks"), { recursive: true });
  await writeFile(
    resolve(repository, source),
    await readFile(resolve(root, source)),
    { mode: 0o755 },
  );
  await symlink(
    resolve(root, "node_modules"),
    resolve(repository, "node_modules"),
  );
  await writeFile(resolve(repository, ".gitignore"), "node_modules\n");
  await writeFile(
    resolve(repository, "agent-tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      branch,
      commits,
      hooks: { files: [{ source, target: "pre-push", executable: true }] },
      pushGate: { steps },
    }),
  );
}

test("the repository requires signed, unattributed commits", async () => {
  const { commits } = await policy();
  expect(commits.signatures).toBe("present");
  expect(commits.rejectCoauthors).toBe(true);
});

test("the push gate checks the pushed commits even when HEAD is different", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "balebase-pre-push-"));
  const repository = resolve(directory, "repository");
  const remote = resolve(directory, "remote.git");
  const { command, git } = runner(fixtureEnv());
  // The marker lives in the Git directory so the working tree stays clean.
  const marker = resolve(repository, ".git/gate-ran");
  const steps = [
    { label: "marker", command: ["sh", "-c", `touch "${marker}"`] },
  ];
  const { commits } = await policy();
  try {
    git(directory, "init", "-q", "-b", "main", repository);
    git(directory, "init", "-q", "--bare", remote);
    git(repository, "config", "user.name", "Hook fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "config", "commit.gpgSign", "false");
    git(
      repository,
      "config",
      "core.hooksPath",
      resolve(repository, ".git/hooks"),
    );
    git(repository, "remote", "add", "origin", remote);
    // Fixture commits are unsigned, so attribution is checked first on its own.
    await adoptGate(repository, { ...commits, signatures: "none" }, steps);
    git(repository, "add", ".");
    git(repository, "commit", "-q", "-m", "chore: fixture base");
    expect(
      command(repository, [cli, "hooks", "install", "--apply"]).exitCode,
    ).toBe(0);
    git(repository, "push", "-q", "--no-verify", "origin", "main");
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "-q", "--no-track", "-c", "feat/forbidden");
    git(
      repository,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "feat: forbidden attribution\n\nCo-authored-by: Fixture <fixture@example.invalid>",
    );
    const forbidden = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "-q", "main");
    git(
      repository,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "feat: valid current head",
    );
    const head = git(repository, "rev-parse", "HEAD");
    const hook = resolve(repository, ".git/hooks/pre-push");
    const gate = (stdin: string) => {
      const result = command(repository, ["sh", hook, "origin", remote], stdin);
      return {
        exitCode: result.exitCode,
        output: result.stdout.toString() + result.stderr.toString(),
      };
    };

    for (const destination of [zero, base]) {
      const rejected = gate(
        `refs/heads/feat/forbidden ${forbidden} refs/heads/feat/forbidden ${destination}\n`,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain("Co-authored-by trailer is forbidden.");
      expect(await Bun.file(marker).exists()).toBe(false);
    }
    const multiple = gate(
      `refs/heads/main ${head} refs/heads/feat/valid ${zero}\n` +
        `refs/heads/feat/forbidden ${forbidden} refs/heads/feat/forbidden ${zero}\n`,
    );
    expect(multiple.exitCode).not.toBe(0);
    expect(multiple.output).toContain("Co-authored-by trailer is forbidden.");
    expect(await Bun.file(marker).exists()).toBe(false);
    const accepted = gate(
      `refs/heads/main ${head} refs/heads/feat/valid ${zero}\n`,
    );
    expect(accepted.exitCode, accepted.output).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);

    // An attributed commit the destination already has, brought in by
    // integrating its moved base, is not this push's to answer for.
    git(
      repository,
      "push",
      "-q",
      "--no-verify",
      "origin",
      `${head}:refs/heads/feat/valid`,
    );
    git(
      repository,
      "push",
      "-q",
      "--no-verify",
      "origin",
      `${forbidden}:refs/heads/main`,
    );
    git(
      repository,
      "merge",
      "-q",
      "--no-ff",
      forbidden,
      "-m",
      "chore: integrate updated main",
    );
    const integrated = git(repository, "rev-parse", "HEAD");
    const mergedBase = gate(
      `refs/heads/main ${integrated} refs/heads/feat/valid ${head}\n`,
    );
    expect(mergedBase.exitCode, mergedBase.output).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    git(
      repository,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "feat: new attribution\n\nCo-authored-by: Fixture <fixture@example.invalid>",
    );
    const rejectedAfterMerge = gate(
      `refs/heads/main ${git(repository, "rev-parse", "HEAD")} refs/heads/feat/valid ${head}\n`,
    );
    expect(rejectedAfterMerge.exitCode).not.toBe(0);
    expect(rejectedAfterMerge.output).toContain(
      "Co-authored-by trailer is forbidden.",
    );

    // With the repository's own signature policy, the unsigned merge is refused.
    const config = resolve(repository, "agent-tool.json");
    await writeFile(
      config,
      JSON.stringify({
        ...JSON.parse(await readFile(config, "utf8")),
        commits,
      }),
    );
    const unsigned = gate(
      `refs/heads/main ${integrated} refs/heads/feat/valid ${head}\n`,
    );
    expect(unsigned.exitCode).not.toBe(0);
    expect(unsigned.output).toContain(
      "Signature does not meet 'present' policy (N)",
    );
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the push gate runs steps outside the pushing worktree's repository", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "balebase-pre-push-"));
  const repository = resolve(directory, "repository");
  const worktree = resolve(directory, "worktree");
  const remote = resolve(directory, "remote.git");
  const { command, git } = runner(fixtureEnv());
  const suite = resolve(directory, "suite");
  const { commits } = await policy();
  // The step leaves Git to find its repository from the working directory,
  // so an inherited GIT_DIR would redirect it to the pushing worktree's. It
  // builds that repository outside the worktree, which run groups fingerprint.
  const steps = [
    {
      label: "suite",
      command: [
        "sh",
        "-c",
        `mkdir "${suite}" && cd "${suite}" && git init -q && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m Fixture`,
      ],
    },
  ];
  try {
    git(directory, "init", "-q", "-b", "main", repository);
    git(directory, "init", "-q", "--bare", remote);
    git(repository, "config", "user.name", "Hook fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "config", "commit.gpgSign", "false");
    git(repository, "remote", "add", "origin", remote);
    await adoptGate(repository, { ...commits, signatures: "none" }, steps);
    git(repository, "add", ".");
    git(repository, "commit", "-q", "-m", "chore: fixture base");
    expect(
      command(repository, [cli, "hooks", "install", "--apply"]).exitCode,
    ).toBe(0);
    git(repository, "worktree", "add", "-q", "-b", "feat/pushed", worktree);
    await symlink(
      resolve(root, "node_modules"),
      resolve(worktree, "node_modules"),
    );
    git(worktree, "commit", "-q", "--allow-empty", "-m", "feat: pushed work");
    const pushed = git(worktree, "rev-parse", "HEAD");
    git(worktree, "push", "-q", "origin", "feat/pushed");
    expect(git(remote, "rev-parse", "feat/pushed")).toBe(pushed);
    expect(git(repository, "config", "--get", "core.bare")).toBe("false");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(git(suite, "log", "--format=%s")).toBe("Fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
