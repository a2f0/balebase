import { expect, onTestFinished, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const skill = resolve(import.meta.dir, "../../skills/audit-trails");
const read = (path: string) => readFileSync(join(skill, path), "utf8");
const issueUrl = "https://github.com/fixture/repo/issues/7";
const priorReadback = "Previous verified checkpoint.\n";
const body =
  "# Report\n\n<!-- audit-usage:run-fixture:begin -->\nIt's unavailable.\n<!-- audit-usage:run-fixture:end -->\n";

// Documentation fixtures only: no GitHub writes, model calls, or application audit.
const stub = `gh() {
  printf '%s\\n' "$*" >> "$receipt_dir/calls"
  test "$2" != "$failure" || return 23
  case "$*" in
    'issue create --repo fixture/repo --title Fixture --body-file '*)
      test "$#" = 8 || return 1
      cmp "$8" "$receipt_dir/expected.md" || return 1
      printf '%s\\n' '${issueUrl}' ;;
    'issue view ${issueUrl} --repo fixture/repo --json url,number,body')
      printf '%s\\n' "$response_json" ;;
    'issue edit ${issueUrl} --repo fixture/repo --body-file '*)
      test "$#" = 7 || return 1
      cmp "$7" "$receipt_dir/expected.md" ;;
    *) return 77 ;;
  esac
}
`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "audit usage docs "));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  // No inherited credentials/config, and no real gh (even via `command gh`).
  for (const command of ["cmp", "jq", "mv"]) {
    const executable = Bun.which(command);
    if (!executable) throw new Error(`Fixture requires ${command}`);
    symlinkSync(executable, join(directory, command));
  }
  writeFileSync(join(directory, "report.md"), body);
  writeFileSync(join(directory, "expected.md"), body);
  writeFileSync(join(directory, "issue-readback.json"), priorReadback);
  const blocks = [
    ...read("references/usage-receipts.md").matchAll(/```sh\n([\s\S]*?)```/g),
  ].map((match) => match[1] ?? "");
  expect(blocks).toHaveLength(3);
  return {
    blocks,
    read: (path: string) => readFileSync(join(directory, path), "utf8"),
    run: (script: string, overrides: Record<string, string> = {}) =>
      Bun.spawnSync(["/bin/sh", "-eu", "-c", `${stub}\n${script}`], {
        env: {
          PATH: directory,
          HOME: directory,
          GH_CONFIG_DIR: directory,
          XDG_CONFIG_HOME: directory,
          repo: "fixture/repo",
          title: "Fixture",
          receipt_dir: directory,
          body_file: join(directory, "report.md"),
          failure: "none",
          response_json: JSON.stringify({ url: issueUrl, number: 7, body }),
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
  };
}

test("audit entry, checkpoints, and delivery share the usage procedure", () => {
  const text = read("SKILL.md");
  const start = text.indexOf("## Establish scope");
  const trace = text.indexOf("## Trace coverage");
  const deliver = text.indexOf("## Deliver");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(trace).toBeGreaterThan(start);
  expect(deliver).toBeGreaterThan(trace);
  expect(text.slice(start, trace)).toContain("references/usage-receipts.md");
  expect(text.slice(start, trace)).toContain("checkpoint");
  expect(text.slice(deliver)).toContain("references/usage-receipts.md");
  expect(read("references/report-template.md")).toContain(
    "## Audit usage receipt",
  );
});

test("receipt examples verify the exact body and URL before saving readback", () => {
  const f = fixture();
  const result = f.run(f.blocks.join("\n"));
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const calls = f.read("calls");
  expect(calls.match(/issue create/g)).toHaveLength(1);
  expect(calls.match(/issue edit/g)).toHaveLength(1);
  expect(calls.match(/issue view/g)).toHaveLength(2);
  expect(f.read("issue-url.txt").trim()).toBe(issueUrl);
  expect(JSON.parse(f.read("issue-readback.json"))).toEqual({
    url: issueUrl,
    number: 7,
    body,
  });
});

test.each(["edit", "view", "body", "url"])(
  "failed %s preserves the earlier checkpoint",
  (failure) => {
    const f = fixture();
    const response = { url: issueUrl, number: 7, body };
    if (failure === "body") response.body = "Wrong receipt";
    if (failure === "url")
      response.url = "https://github.com/fixture/repo/issues/8";
    const result = f.run(f.blocks[2] ?? "", {
      issue_url: issueUrl,
      failure,
      response_json: JSON.stringify(response),
    });
    expect(result.exitCode).not.toBe(0);
    expect(f.read("issue-readback.json")).toBe(priorReadback);
    expect(f.read("report.md")).toBe(body);
    expect(f.read("calls")).not.toContain("issue create");
  },
);

test("documentation fixtures fail closed if a command bypasses gh stub", () => {
  const f = fixture();
  expect(f.run("command gh issue view anything").exitCode).toBe(127);
  expect(f.run("env gh issue view anything").exitCode).toBe(127);
  expect(f.run(`test -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}"`).exitCode).toBe(0);
});

test("all local audit skill links and fragments resolve", () => {
  for (const file of [
    "SKILL.md",
    "references/report-template.md",
    "references/usage-receipts.md",
  ]) {
    for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1] ?? "";
      if (target.includes("://") || target.startsWith("#")) continue;
      const [path = "", fragment] = target.split("#");
      const linked = readFileSync(resolve(skill, file, "..", path), "utf8");
      expect(linked.length).toBeGreaterThan(0);
      if (fragment) {
        const headings = [...linked.matchAll(/^#+ (.+)$/gm)].map((heading) =>
          (heading[1] ?? "")
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s/g, "-"),
        );
        expect(headings).toContain(fragment);
      }
    }
  }
});
