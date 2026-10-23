import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("pre-push checks the pushed commits even when HEAD is different", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "balebase-pre-push-"));
  const root = resolve(import.meta.dir, "../..");
  const cli = resolve(root, "node_modules/.bin/agent-tool");
  const zero = "0".repeat(40);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const command = (args: string[], stdin?: string) =>
    Bun.spawnSync(args, {
      cwd: directory,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  const git = (...args: string[]) => {
    const result = command(["git", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Hook fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgSign", "false");
    git("config", "core.hooksPath", resolve(directory, ".git/hooks"));
    git("commit", "--allow-empty", "-m", "chore: fixture base");
    const base = git("rev-parse", "HEAD");
    git("remote", "add", "origin", resolve(directory, "unused-remote"));
    git("update-ref", "refs/remotes/origin/main", base);
    git("switch", "--no-track", "-c", "feat/forbidden");
    git(
      "commit",
      "--allow-empty",
      "-m",
      "feat: forbidden attribution\n\nCo-authored-by: Fixture <fixture@example.invalid>",
    );
    const forbidden = git("rev-parse", "HEAD");
    git("switch", "main");
    git("commit", "--allow-empty", "-m", "feat: valid current head");
    const head = git("rev-parse", "HEAD");
    const source = "scripts/git/hooks/pre-push";
    await mkdir(resolve(directory, "scripts/git/hooks"), { recursive: true });
    await writeFile(
      resolve(directory, source),
      await readFile(resolve(root, source)),
    );
    await writeFile(
      resolve(directory, "agent-tool.json"),
      JSON.stringify({
        schemaVersion: 1,
        branch: { types: ["feat"], exempt: ["main"], maxLength: null },
        commits: { signatures: "none", rejectCoauthors: true },
        hooks: { files: [{ source, target: "pre-push", executable: true }] },
      }),
    );
    await writeFile(
      resolve(directory, "package.json"),
      JSON.stringify({
        scripts: {
          "agent-tool": JSON.stringify(cli),
          "hooks:check": `${JSON.stringify(cli)} hooks check`,
          "lint:branch-name": `${JSON.stringify(cli)} branch check`,
          check: 'bun -e \'await Bun.write("verified", "yes")\'',
          test: "true",
        },
      }),
    );
    git("add", ".");
    expect(command([cli, "hooks", "install", "--apply"]).exitCode).toBe(0);
    const hook = resolve(directory, ".git/hooks/pre-push");
    for (const destination of [zero, base]) {
      const rejected = command(
        ["sh", hook, "origin"],
        `refs/heads/feat/forbidden ${forbidden} refs/heads/feat/forbidden ${destination}\n`,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stdout.toString() + rejected.stderr.toString()).toContain(
        "Co-authored-by",
      );
      expect(await Bun.file(resolve(directory, "verified")).exists()).toBe(
        false,
      );
    }
    const multiple = command(
      ["sh", hook, "origin"],
      `refs/heads/main ${head} refs/heads/feat/valid ${zero}\n` +
        `refs/heads/feat/forbidden ${forbidden} refs/heads/feat/forbidden ${zero}\n`,
    );
    expect(multiple.exitCode).not.toBe(0);
    expect(multiple.stdout.toString() + multiple.stderr.toString()).toContain(
      "Co-authored-by",
    );
    await rm(resolve(directory, "verified"), { force: true });
    const accepted = command(
      ["sh", hook, "origin"],
      `refs/heads/main ${head} refs/heads/feat/valid ${zero}\n`,
    );
    expect(accepted.exitCode).toBe(0);
    expect(await Bun.file(resolve(directory, "verified")).text()).toBe("yes");
    git("commit", "-m", "chore: install fixture tooling");
    const previous = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/feat/valid", previous);
    git("update-ref", "refs/remotes/origin/main", forbidden);
    git("merge", "--no-ff", forbidden, "-m", "chore: integrate updated main");
    const integrated = git("rev-parse", "HEAD");
    const mergedBase = command(
      ["sh", hook, "origin"],
      `refs/heads/main ${integrated} refs/heads/feat/valid ${previous}\n`,
    );
    expect(mergedBase.exitCode, mergedBase.stderr.toString()).toBe(0);
    git(
      "commit",
      "--allow-empty",
      "-m",
      "feat: new attribution\n\nCo-authored-by: Fixture <fixture@example.invalid>",
    );
    const rejectedAfterMerge = command(
      ["sh", hook, "origin"],
      `refs/heads/main ${git("rev-parse", "HEAD")} refs/heads/feat/valid ${previous}\n`,
    );
    expect(rejectedAfterMerge.exitCode).not.toBe(0);
    expect(
      rejectedAfterMerge.stdout.toString() +
        rejectedAfterMerge.stderr.toString(),
    ).toContain("Co-authored-by");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
