import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const fencedBash = /^( *)```bash\n([\s\S]*?)\n\1```$/gm;

// The sweep and the retirement delete directories, so these tests run the
// snippets exactly as both skill copies print them, against real worktrees.
function squashMergeSnippets() {
  const copies = [".claude/skills", ".codex/skills"].map((skillRoot) => {
    const content = readFileSync(
      path.join(repositoryRoot, skillRoot, "squash-merge/SKILL.md"),
      "utf8",
    );
    const blocks = [...content.matchAll(fencedBash)].map(
      ([, indent = "", body = ""]) =>
        body
          .split("\n")
          .map((line) =>
            line.startsWith(indent) ? line.slice(indent.length) : line,
          )
          .join("\n"),
    );
    const helper = /^holds_ignored_state\(\) \{\n[\s\S]*?\n\}$/m.exec(content);
    return {
      helper: helper?.[0] ?? "",
      retire: blocks.find((block) => block.includes("GIT_COMMON_DIR=")) ?? "",
      sweep: blocks.find((block) => block.includes("git worktree prune")) ?? "",
    };
  });
  const [first, second] = copies;
  expect(second).toEqual(first);
  if (first === undefined) throw new Error("squash-merge skill is missing");
  expect(first.helper).toContain("holds_ignored_state() {");
  expect(first.sweep).toContain('git worktree remove "$WT_PATH"');
  expect(first.retire).toContain('git worktree remove "$SELF_ROOT"');
  return first;
}

// Stands in for gh: a worktree named <name> on branch feat/<name> has a
// merged PR when merged/<name> holds that PR's head.
const prelude = [
  "REALPATH_BIN=/usr/bin/realpath",
  '[ -x "$REALPATH_BIN" ] || REALPATH_BIN=/bin/realpath',
  "REPO=example/repo",
  "gh() {",
  '  head_branch=""',
  '  while [ "$#" -gt 0 ]; do',
  '    [ "$1" != --head ] || head_branch=$2',
  "    shift",
  "  done",
  '  merged_head="$FIXTURE/merged/$(basename "$head_branch")"',
  '  [ ! -f "$merged_head" ] || cat "$merged_head"',
  "}",
].join("\n");

const fixtureHelpers = [
  "set -eu",
  'mkdir -p "$FIXTURE/merged"',
  'git init -q -b main "$FIXTURE/primary"',
  'cd "$FIXTURE/primary"',
  "printf '%s\\n' '.env*' .secrets/ .wrangler/ build/ > .gitignore",
  "git add .gitignore",
  "git commit -q -m init",
  "branch() {",
  '  git worktree add -q -b "feat/$1" "../$1"',
  '  git -C "../$1" commit -q --allow-empty -m "$1"',
  "}",
  'merged() { git -C "../$1" rev-parse HEAD > "$FIXTURE/merged/$1"; }',
];

function run(script: string, cwd: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "agent@example.invalid",
      GIT_AUTHOR_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.invalid",
      GIT_COMMITTER_NAME: "Agent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: String(Reflect.get(process.env, "PATH") ?? ""),
      ...env,
    },
  });
}

function withFixture(
  setup: readonly string[],
  check: (fixture: string) => void,
  env: Record<string, string> = {},
) {
  const fixture = mkdtempSync(path.join(tmpdir(), "squash-merge-worktrees-"));
  try {
    const created = run([...fixtureHelpers, ...setup].join("\n"), fixture, {
      ...env,
      FIXTURE: fixture,
    });
    if (created.status !== 0) throw new Error(created.stderr);
    check(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function worktreeNames(fixture: string) {
  const listed = run(
    "git worktree list --porcelain",
    path.join(fixture, "primary"),
  );
  return listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.basename(line.slice("worktree ".length)))
    .sort();
}

test("squash-merge keeps worktrees holding ignored credentials or state", () => {
  const { helper } = squashMergeSnippets();
  const cases: [ignoredFile: string, held: boolean][] = [
    ["build/app.js", false],
    [".env.local", true],
    [".secrets/prod.json", true],
    // Git quotes a non-ASCII name unless it is read NUL-delimited.
    [".secrets/prodé.json", true],
    ["build/upload/.env", true],
    ["build/.terraform/terraform.tfstate", true],
    ["packages/api/.wrangler/state/v3/d1/db.sqlite", true],
    ["packages/api/.wrangler/tmp/bundle/index.js", false],
  ];
  for (const [ignoredFile, held] of cases) {
    withFixture(
      ['mkdir -p "$(dirname "$IGNORED_FILE")"', ': > "$IGNORED_FILE"'],
      (fixture) => {
        const result = run(
          `${helper}\nholds_ignored_state .`,
          path.join(fixture, "primary"),
        );
        expect({ ignoredFile, status: result.status }).toEqual({
          ignoredFile,
          status: held ? 0 : 1,
        });
      },
      { IGNORED_FILE: ignoredFile },
    );
  }

  // A listing git cannot produce counts as holding state.
  const unreadable = run(
    `${helper}\nholds_ignored_state /nonexistent/checkout`,
    tmpdir(),
  );
  expect(unreadable.status).toBe(0);
});

test("squash-merge sweeps only clean worktrees at a merged PR's head", () => {
  const { helper, sweep } = squashMergeSnippets();
  withFixture(
    [
      "branch done; merged done",
      "branch bundled; merged bundled",
      "mkdir -p ../bundled/.wrangler/tmp; : > ../bundled/.wrangler/tmp/index.js",
      "branch wrangler; merged wrangler",
      "mkdir -p ../wrangler/.wrangler/state; : > ../wrangler/.wrangler/state/db",
      "branch open",
      "branch moved; merged moved",
      "git -C ../moved commit -q --allow-empty -m 'after merge'",
      "branch dirty; merged dirty; : > ../dirty/notes.txt",
      "branch state; merged state",
      "mkdir -p ../state/build; : > ../state/build/.env",
      "branch quoted; merged quoted; mkdir -p ../quoted/.secrets",
      ": > '../quoted/.secrets/prodé.json'",
      "branch locked; merged locked; git worktree lock ../locked",
      "git worktree add -q --detach ../detached",
      "branch self; merged self",
    ],
    (fixture) => {
      const result = run(
        `${prelude}\n${helper}\n${sweep}`,
        path.join(fixture, "self"),
        { FIXTURE: fixture },
      );
      expect(result.status).toBe(0);
      const outcomes = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => /^(Kept|Removed) (.+) \((.+)\)$/.exec(line))
          .map((match) => [
            path.basename(match?.[2] ?? ""),
            `${match?.[1]}: ${match?.[3]}`,
          ]),
      );
      expect(outcomes).toEqual({
        bundled: "Removed: feat/bundled",
        detached: "Kept: detached HEAD",
        dirty: "Kept: uncommitted, untracked, or unreadable",
        done: "Removed: feat/done",
        locked: "Kept: locked",
        moved: "Kept: no merged PR at its tip",
        open: "Kept: no merged PR at its tip",
        quoted: "Kept: ignored credentials or local state",
        state: "Kept: ignored credentials or local state",
        wrangler: "Kept: ignored credentials or local state",
      });
      expect(worktreeNames(fixture)).toEqual([
        "detached",
        "dirty",
        "locked",
        "moved",
        "open",
        "primary",
        "quoted",
        "self",
        "state",
        "wrangler",
      ]);
      expect(existsSync(path.join(fixture, "done"))).toBe(false);
      expect(existsSync(path.join(fixture, "bundled"))).toBe(false);
      const branches = run(
        "git branch --format='%(refname:short)'",
        path.join(fixture, "primary"),
      ).stdout;
      expect(branches).not.toContain("feat/done");
      expect(branches).toContain("feat/moved");
    },
  );
});

test("squash-merge retires its worktree only after a completed cleanup", () => {
  const { helper, retire } = squashMergeSnippets();
  // Step 4 detaches at the base tip, then deletes the merged branch.
  const detached = [
    "branch self",
    "git -C ../self -c core.hooksPath=/dev/null switch -q --detach main",
  ];
  const cases: [name: string, setup: string[], retired: boolean][] = [
    ["completed", [...detached, "git branch -q -D feat/self"], true],
    ["branch still present", detached, false],
    [
      "ignored state",
      [...detached, "git branch -q -D feat/self", ": > ../self/.env"],
      false,
    ],
    [
      "merge not contained",
      [
        ...detached,
        "git branch -q -D feat/self",
        "git commit -q --allow-empty -m merge",
      ],
      false,
    ],
  ];
  for (const [name, setup, retired] of cases) {
    withFixture(setup, (fixture) => {
      const mergeCommit = run(
        "git rev-parse main",
        path.join(fixture, "primary"),
      ).stdout.trim();
      const result = run(
        `${prelude}\n${helper}\n${retire}\npwd`,
        path.join(fixture, "self"),
        { MERGE_COMMIT: mergeCommit, MERGED_BRANCH: "feat/self" },
      );
      expect({
        name,
        exists: existsSync(path.join(fixture, "self")),
        status: result.status,
      }).toEqual({ name, exists: !retired, status: retired ? 0 : 1 });
      if (retired) {
        expect(path.basename(result.stdout.trim())).toBe("primary");
      }
    });
  }
});
