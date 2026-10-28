import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");

// `bun run [--cwd <dir>] <script>`; whitespace may wrap across lines.
const command =
  /\bbun\s+(?:--bun\s+)?run\s+(?:--cwd[\s=]+["']?([^\s"'`]+)["']?\s+)?([^\s`'"()|;&<>]+)/g;
const fence = /^\s*(```|~~~)/;
const cd = /^\s*cd\s+(\S+)\s*$/;

interface Reference {
  file: string;
  line: number;
  script: string;
  // Package directories whose scripts may satisfy the reference, in order.
  directories: string[];
}

// Tracked Markdown, excluding the skills generated from the pinned agent-tool.
function markdownFiles() {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", "*.md", ":!.claude/**", ":!.agents/**"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\0").filter(Boolean);
}

// The directory each line runs in when a fenced block starts with `cd`.
function fencedDirectories(lines: string[]) {
  const directories: (string | undefined)[] = [];
  let inFence = false;
  let directory: string | undefined;
  for (const line of lines) {
    if (fence.test(line)) {
      inFence = !inFence;
      directory = undefined;
    } else if (inFence) {
      directory = line.match(cd)?.[1] ?? directory;
    }
    directories.push(directory);
  }
  return directories;
}

function references(file: string): Reference[] {
  const text = readFileSync(join(repo, file), "utf8");
  const lines = text.split("\n");
  const fenced = fencedDirectories(lines);
  // A package's own docs may name its scripts or the repository's.
  const owner = file.match(/^(packages\/[^/]+)\//)?.[1];
  const defaults = owner ? [owner, "."] : ["."];
  return [...text.matchAll(command)].map((match) => {
    const line = text.slice(0, match.index).split("\n").length;
    const directory = match[1] ?? fenced[line - 1];
    return {
      file,
      line,
      script: match[2] ?? "",
      directories: directory ? [posix.normalize(directory)] : defaults,
    };
  });
}

const scriptsByDirectory = new Map<string, Set<string>>();
function scriptsIn(directory: string) {
  let scripts = scriptsByDirectory.get(directory);
  if (!scripts) {
    const manifest = join(repo, directory, "package.json");
    const parsed = existsSync(manifest)
      ? (JSON.parse(readFileSync(manifest, "utf8")) as {
          scripts?: Record<string, string>;
        })
      : {};
    scripts = new Set(Object.keys(parsed.scripts ?? {}));
    scriptsByDirectory.set(directory, scripts);
  }
  return scripts;
}

test("every documented bun run script exists in its package", () => {
  const found = markdownFiles().flatMap(references);
  // Guard against a pattern change that silently matches nothing.
  expect(found.length).toBeGreaterThan(100);
  const missing = found
    .filter(({ script, directories }) =>
      directories.every((directory) => !scriptsIn(directory).has(script)),
    )
    .map(
      ({ file, line, script, directories }) =>
        `${file}:${line}: bun run ${script} (not a script in ${directories
          .map((directory) => join(directory, "package.json"))
          .join(" or ")})`,
    );
  expect(missing).toEqual([]);
});
