import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const fencedBash = /^( *)```bash\n([\s\S]*?)\n\1```$/gm;

// Worktree cleanup deletes directories and branches, so these tests run the
// skills' snippets exactly as both mirrored copies print them.
function skillSnippets(skill: string) {
  const [content, mirror] = [".claude/skills", ".codex/skills"].map(
    (skillRoot) =>
      readFileSync(path.join(repositoryRoot, skillRoot, skill, "SKILL.md"), {
        encoding: "utf8",
      }),
  );
  expect(mirror).toBe(content);
  if (content === undefined) throw new Error(`${skill} skill is missing`);
  const blocks = [...content.matchAll(fencedBash)].map(
    ([, indent = "", body = ""]) =>
      body
        .split("\n")
        .map((line) =>
          line.startsWith(indent) ? line.slice(indent.length) : line,
        )
        .join("\n"),
  );
  return {
    block(marker: string) {
      const matching = blocks.filter((block) => block.includes(marker));
      expect(matching.length).toBe(1);
      return matching[0] ?? "";
    },
    content,
  };
}

function squashMergeSnippets() {
  const skill = skillSnippets("squash-merge");
  const helpers = ["holds_ignored_state", "hides_tracked_changes"].map(
    (name) => {
      const helper = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m");
      const match = helper.exec(skill.content);
      expect({ name, found: match !== null }).toEqual({ name, found: true });
      return match?.[0] ?? "";
    },
  );
  const retireGates = skill.block("GIT_COMMON_DIR=");
  const retireRemoval = skill.block('if [ "$RETIRE_READY" = true ]');
  return {
    cleanup: skill.block("BASE_CHECKOUTS="),
    helper: helpers.join("\n"),
    retire: `${retireGates}\n${retireRemoval}`,
    retireGates,
    sweep: skill.block("worktree prune"),
  };
}

function resetSnippet() {
  const skill = skillSnippets("reset");
  return [
    "BRANCH=$(git rev-parse --abbrev-ref HEAD)",
    'ROOT_DIR=$("$REALPATH_BIN" "$(git rev-parse --show-toplevel)")',
    skill.block("FETCHED_UPSTREAM=$(git rev-parse"),
    skill.block("TARGET_CHECKOUTS="),
  ].join("\n");
}

// Stands in for gh. `pr view` reports the squash commit squash() landed; a
// worktree named <name> on feat/<name> has a merged PR when merged/<name>
// holds that PR's head.
const prelude = [
  "REALPATH_BIN=/usr/bin/realpath",
  '[ -x "$REALPATH_BIN" ] || REALPATH_BIN=/bin/realpath',
  "REPO=example/repo",
  "gh() {",
  '  case "$1 $2" in',
  '    "pr view") cat "$FIXTURE/merge-commit" ;;',
  '    "pr list")',
  '      head_branch=""',
  '      while [ "$#" -gt 0 ]; do',
  '        [ "$1" != --head ] || head_branch=$2',
  "        shift",
  "      done",
  '      merged_head="$FIXTURE/merged/$(basename "$head_branch")"',
  '      [ ! -f "$merged_head" ] || cat "$merged_head"',
  "      ;;",
  "  esac",
  "}",
].join("\n");

const fixtureHelpers = [
  "set -eu",
  'mkdir -p "$FIXTURE/merged"',
  'git init -q --bare -b main "$FIXTURE/origin.git"',
  'git init -q -b main "$FIXTURE/primary"',
  'cd "$FIXTURE/primary"',
  "printf '%s\\n' '.env*' .secrets/ .wrangler/ .terraform/ dist/ > .gitignore",
  "printf '%s\\n' node_modules/ '*.tsbuildinfo' '*.tfvars' override.tf >> .gitignore",
  "printf 'base\\n' > README",
  "git add .gitignore README",
  "git commit -q -m init",
  'git remote add origin "$FIXTURE/origin.git"',
  "git push -q origin main",
  "branch() {",
  '  git worktree add -q -b "feat/$1" "../$1"',
  '  git -C "../$1" commit -q --allow-empty -m "$1"',
  "}",
  'merged() { git -C "../$1" rev-parse HEAD > "$FIXTURE/merged/$1"; }',
  // Publishes feat/<name>, then lands a squash of it on origin's main.
  "squash() {",
  '  git -C "../$1" push -q origin "feat/$1"',
  "  git fetch -q origin main",
  '  squashed=$(git commit-tree -p FETCH_HEAD -m "$1" "feat/$1^{tree}")',
  '  git push -q origin "$squashed:refs/heads/main"',
  '  printf \'%s\\n\' "$squashed" > "$FIXTURE/merge-commit"',
  "}",
  // Installs hooks the snippets must never run; each leaves hook-ran behind.
  "arm_hooks() {",
  "  for hook in reference-transaction post-checkout post-merge pre-push \\",
  "    post-index-change; do",
  '    printf \'#!/bin/sh\\ntouch "%s/hook-ran"\\n\' "$FIXTURE" > ".git/hooks/$hook"',
  '    chmod +x ".git/hooks/$hook"',
  "  done",
  "}",
  // Configures an fsmonitor command, which runs even with hooks disabled.
  "arm_fsmonitor() {",
  '  printf \'#!/bin/sh\\ntouch "%s/hook-ran"\\nexit 1\\n\' "$FIXTURE" > ../fsmonitor',
  "  chmod +x ../fsmonitor",
  '  git config core.fsmonitor "$FIXTURE/fsmonitor"',
  "}",
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
  const fixture = mkdtempSync(path.join(tmpdir(), "worktree-cleanup-"));
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

function git(cwd: string, command: string) {
  return run(`git ${command}`, cwd).stdout.trim();
}

function worktreeNames(fixture: string) {
  return git(path.join(fixture, "primary"), "worktree list --porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.basename(line.slice("worktree ".length)))
    .sort();
}

// Lands one more commit on origin's main, as a later merge would.
function advanceOrigin(fixture: string) {
  const primary = path.join(fixture, "primary");
  const advanced = run(
    [
      "set -eu",
      "git -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch -q origin main",
      'later=$(git commit-tree -p FETCH_HEAD -m later "FETCH_HEAD^{tree}")',
      'git -c core.hooksPath=/dev/null push -q origin "$later:refs/heads/main"',
      'printf "%s" "$later"',
    ].join("\n"),
    primary,
  );
  if (advanced.status !== 0) throw new Error(advanced.stderr);
  return advanced.stdout;
}

function cleanupEnvironment(fixture: string, name: string) {
  const originUrl = path.join(fixture, "origin.git");
  return {
    BASE_BRANCH: "main",
    BASE_REPO_URL: originUrl,
    BRANCH: `feat/${name}`,
    FEATURE_REMOTE: "origin",
    FEATURE_REPO_URL: originUrl,
    FIXTURE: fixture,
    PR_HEAD_SHA: git(path.join(fixture, name), "rev-parse HEAD"),
    PR_NUMBER: "1",
  };
}

test("squash-merge keeps worktrees holding ignored files beyond build output", () => {
  const { helper } = squashMergeSnippets();
  const cases: [ignoredFile: string, held: boolean][] = [
    ["dist/app.js", false],
    ["node_modules/pkg/.env", false],
    ["tsconfig.tsbuildinfo", false],
    ["packages/api/.wrangler/tmp/bundle/index.js", false],
    // Git quotes a non-ASCII name unless it is read NUL-delimited.
    ["dist/appé.js", false],
    [".secrets/prodé.json", true],
    [".env.local", true],
    ["terraform/prod.tfvars", true],
    ["terraform/override.tf", true],
    ["terraform/.terraform/terraform.tfstate", true],
    ["packages/api/.wrangler/state/v3/d1/db.sqlite", true],
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

  withFixture(["arm_hooks", "arm_fsmonitor"], (fixture) => {
    const clean = run(
      `${helper}\nholds_ignored_state .`,
      path.join(fixture, "primary"),
    );
    expect(clean.status).toBe(1);
    expect(existsSync(path.join(fixture, "hook-ran"))).toBe(false);
  });

  // Under pipefail, stopping at the first kept file would cut the listing
  // short, and the broken pipe would read as clean.
  withFixture(
    ["mkdir dist", "(cd dist && seq 20000 | xargs touch)", ": > .env"],
    (fixture) => {
      const result = run(
        `set -o pipefail\n${helper}\nholds_ignored_state .`,
        path.join(fixture, "primary"),
      );
      expect(result.status).toBe(0);
    },
  );

  // A listing git cannot produce keeps the worktree.
  const unreadable = run(
    `${helper}\nholds_ignored_state /nonexistent/checkout`,
    tmpdir(),
  );
  expect(unreadable.status).toBe(0);
});

test("squash-merge keeps worktrees whose tracked edits status cannot see", () => {
  const { helper } = squashMergeSnippets();
  const cases: [name: string, setup: string[], hidden: boolean][] = [
    ["clean", [], false],
    [
      "assume-unchanged edit",
      ["echo edit >> README", "git update-index --assume-unchanged README"],
      true,
    ],
    [
      "skip-worktree edit",
      ["git update-index --skip-worktree README", "echo edit >> README"],
      true,
    ],
  ];
  for (const [name, setup, hidden] of cases) {
    withFixture(setup, (fixture) => {
      const result = run(
        `${helper}\nhides_tracked_changes .`,
        path.join(fixture, "primary"),
      );
      expect({ name, status: result.status }).toEqual({
        name,
        status: hidden ? 0 : 1,
      });
    });
  }

  // A listing git cannot produce keeps the worktree.
  const unreadable = run(
    `${helper}\nhides_tracked_changes /nonexistent/checkout`,
    tmpdir(),
  );
  expect(unreadable.status).toBe(0);
});

test("squash-merge sweeps only clean worktrees at a merged PR's head", () => {
  const { helper, sweep } = squashMergeSnippets();
  // Another session commits to feat/raced right after its worktree goes.
  const raceAfterRemoval = [
    "git() {",
    '  command git "$@" || return',
    '  case " $* " in',
    '    *" worktree remove "*/raced" "*)',
    "      command git -c core.hooksPath=/dev/null update-ref \\",
    '        refs/heads/feat/raced "$(cat "$FIXTURE/raced-new")"',
    "      ;;",
    "  esac",
    "}",
  ].join("\n");
  withFixture(
    [
      "branch done; merged done",
      "branch built; merged built",
      "mkdir -p ../built/dist ../built/node_modules/pkg",
      ": > '../built/dist/appé.js'; : > ../built/node_modules/pkg/.env",
      "branch bundled; merged bundled",
      "mkdir -p ../bundled/.wrangler/tmp; : > ../bundled/.wrangler/tmp/index.js",
      "branch wrangler; merged wrangler",
      "mkdir -p ../wrangler/.wrangler/state; : > ../wrangler/.wrangler/state/db",
      "branch raced; merged raced",
      'git rev-parse main > "$FIXTURE/raced-new"',
      "branch open",
      "branch moved; merged moved",
      "git -C ../moved commit -q --allow-empty -m 'after merge'",
      "branch dirty; merged dirty; : > ../dirty/notes.txt",
      "branch state; merged state",
      "mkdir -p ../state/build; : > ../state/build/.env",
      "branch quoted; merged quoted; mkdir -p ../quoted/.secrets",
      ": > '../quoted/.secrets/prodé.json'",
      "branch locked; merged locked; git worktree lock ../locked",
      "branch hidden; merged hidden; echo edit >> ../hidden/README",
      "git -C ../hidden update-index --assume-unchanged README",
      "branch skipped; merged skipped",
      "git -C ../skipped update-index --skip-worktree README",
      "echo edit >> ../skipped/README",
      "git worktree add -q --detach ../detached",
      "branch self; merged self",
      "arm_hooks",
      "arm_fsmonitor",
    ],
    (fixture) => {
      const result = run(
        `${prelude}\n${raceAfterRemoval}\n${helper}\n${sweep}`,
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
        built: "Removed: feat/built",
        bundled: "Removed: feat/bundled",
        detached: "Kept: detached HEAD",
        dirty: "Kept: uncommitted, untracked, or unreadable",
        done: "Removed: feat/done",
        hidden: "Kept: tracked files hidden from status",
        locked: "Kept: locked",
        moved: "Kept: no merged PR at its tip",
        open: "Kept: no merged PR at its tip",
        quoted: "Kept: ignored files beyond build output",
        raced: "Removed: kept feat/raced, which moved",
        skipped: "Kept: tracked files hidden from status",
        state: "Kept: ignored files beyond build output",
        wrangler: "Kept: ignored files beyond build output",
      });
      expect(worktreeNames(fixture)).toEqual([
        "detached",
        "dirty",
        "hidden",
        "locked",
        "moved",
        "open",
        "primary",
        "quoted",
        "self",
        "skipped",
        "state",
        "wrangler",
      ]);
      for (const removed of ["built", "bundled", "done", "raced"]) {
        expect({
          removed,
          exists: existsSync(path.join(fixture, removed)),
        }).toEqual({ removed, exists: false });
      }
      const primary = path.join(fixture, "primary");
      const branches = git(primary, "branch --format='%(refname:short)'");
      expect(branches).not.toContain("feat/done");
      expect(branches).toContain("feat/moved");
      expect(existsSync(path.join(fixture, "hook-ran"))).toBe(false);
      expect(git(primary, "rev-parse feat/raced")).toBe(
        readFileSync(path.join(fixture, "raced-new"), "utf8").trim(),
      );
    },
  );
});

// A non-ASCII name checks that no step mistakes a quoted path for another.
const featureNames = ["feature", "featuré"];

test("a merge from a linked worktree detaches, resets, and retires it", () => {
  const { cleanup, helper, retire, retireGates } = squashMergeSnippets();
  const resetScript = resetSnippet();
  for (const name of featureNames) {
    const setup = [
      `branch ${name}`,
      `squash ${name}`,
      "arm_hooks",
      "arm_fsmonitor",
    ];
    withFixture(setup, (fixture) => {
      const primary = path.join(fixture, "primary");
      const feature = path.join(fixture, name);
      const primaryMain = git(primary, "rev-parse main");
      const mergeCommit = readFileSync(
        path.join(fixture, "merge-commit"),
        "utf8",
      ).trim();

      // The primary checkout holds main, so the cleanup cannot switch to it.
      const cleaned = run(
        `${prelude}\n${cleanup}`,
        feature,
        cleanupEnvironment(fixture, name),
      );
      expect({ name, status: cleaned.status }).toEqual({ name, status: 0 });
      expect(git(feature, "rev-parse --abbrev-ref HEAD")).toBe("HEAD");
      expect(git(feature, "rev-parse HEAD")).toBe(mergeCommit);
      expect(git(primary, `branch --list feat/${name}`)).toBe("");
      expect(git(primary, `ls-remote --heads origin feat/${name}`)).toBe("");

      const later = advanceOrigin(fixture);
      const resetRun = run(`${prelude}\n${resetScript}`, feature, {
        TARGET_BRANCH: "main",
      });
      expect({ name, status: resetRun.status }).toEqual({ name, status: 0 });
      expect(git(feature, "rev-parse --abbrev-ref HEAD")).toBe("HEAD");
      expect(git(feature, "rev-parse HEAD")).toBe(later);

      // Another worktree's branch is never moved on its behalf.
      expect(git(primary, "rev-parse --abbrev-ref HEAD")).toBe("main");
      expect(git(primary, "rev-parse main")).toBe(primaryMain);

      const retireEnvironment = {
        BASE_BRANCH: "main",
        BASE_REPO_URL: path.join(fixture, "origin.git"),
        MERGE_COMMIT: mergeCommit,
        MERGED_BRANCH: `feat/${name}`,
      };
      // ExitWorktree takes the place of the removal block, so the gates alone
      // must approve the worktree and leave it in place.
      const gated = run(
        `${prelude}\n${helper}\n${retireGates}\necho "$RETIRE_READY"`,
        feature,
        retireEnvironment,
      );
      expect({ name, status: gated.status }).toEqual({ name, status: 0 });
      expect(gated.stdout.trim()).toBe("true");
      expect(existsSync(feature)).toBe(true);

      const retired = run(
        `${prelude}\n${helper}\n${retire}\npwd`,
        feature,
        retireEnvironment,
      );
      expect({ name, status: retired.status }).toEqual({ name, status: 0 });
      expect(existsSync(feature)).toBe(false);
      expect(path.basename(retired.stdout.trim())).toBe("primary");
      expect(worktreeNames(fixture)).toEqual(["primary"]);
      expect(existsSync(path.join(fixture, "hook-ran"))).toBe(false);
    });
  }
});

test("a merge switches to the base when no worktree holds it", () => {
  const { cleanup } = squashMergeSnippets();
  const resetScript = resetSnippet();
  for (const name of featureNames) {
    withFixture(
      [
        `branch ${name}`,
        `squash ${name}`,
        "git switch -q -c idle",
        "arm_hooks",
      ],
      (fixture) => {
        const feature = path.join(fixture, name);
        const mergeCommit = readFileSync(
          path.join(fixture, "merge-commit"),
          "utf8",
        ).trim();

        const cleaned = run(
          `${prelude}\n${cleanup}`,
          feature,
          cleanupEnvironment(fixture, name),
        );
        expect({ name, status: cleaned.status }).toEqual({ name, status: 0 });
        expect(git(feature, "rev-parse --abbrev-ref HEAD")).toBe("main");
        expect(git(feature, "rev-parse HEAD")).toBe(mergeCommit);

        const later = advanceOrigin(fixture);
        const resetRun = run(`${prelude}\n${resetScript}`, feature, {
          TARGET_BRANCH: "main",
        });
        expect({ name, status: resetRun.status }).toEqual({ name, status: 0 });
        expect(git(feature, "rev-parse --abbrev-ref HEAD")).toBe("main");
        expect(git(feature, "rev-parse HEAD")).toBe(later);
        expect(existsSync(path.join(fixture, "hook-ran"))).toBe(false);
      },
    );
  }
});

test("squash-merge retires its worktree only after a completed cleanup", () => {
  const { helper, retire, retireGates } = squashMergeSnippets();
  // Each case departs from a completed cleanup in one way.
  const detached = [
    "branch self",
    "git -C ../self -c core.hooksPath=/dev/null switch -q --detach main",
  ];
  const cases: [name: string, setup: string[]][] = [
    ["branch still present", detached],
    [
      "hidden tracked edit",
      [
        ...detached,
        "git branch -q -D feat/self",
        "echo edit >> ../self/README",
        "git -C ../self update-index --assume-unchanged README",
      ],
    ],
    [
      "ignored state",
      [...detached, "git branch -q -D feat/self", ": > ../self/.env"],
    ],
    [
      "untracked file",
      [...detached, "git branch -q -D feat/self", ": > ../self/notes.txt"],
    ],
    [
      "commit after cleanup",
      [
        ...detached,
        "git branch -q -D feat/self",
        "git -C ../self commit -q --allow-empty -m 'only copy'",
      ],
    ],
    [
      "merge not contained",
      [
        ...detached,
        "git branch -q -D feat/self",
        "git commit -q --allow-empty -m merge",
      ],
    ],
  ];
  for (const [name, setup] of cases) {
    withFixture(setup, (fixture) => {
      const environment = {
        BASE_BRANCH: "main",
        BASE_REPO_URL: path.join(fixture, "origin.git"),
        MERGE_COMMIT: git(path.join(fixture, "primary"), "rev-parse main"),
        MERGED_BRANCH: "feat/self",
      };
      // The gates alone decide for ExitWorktree; with the removal block they
      // decide for git.
      for (const script of [`${retireGates}\necho "$RETIRE_READY"`, retire]) {
        const result = run(
          `${prelude}\n${helper}\n${script}`,
          path.join(fixture, "self"),
          environment,
        );
        expect({
          name,
          approved: result.stdout.includes("true"),
          exists: existsSync(path.join(fixture, "self")),
          status: result.status,
        }).toEqual({ name, approved: false, exists: true, status: 1 });
      }
    });
  }
});
