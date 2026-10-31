import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const skill = resolve(import.meta.dir, "../../skills/audit-trails");
const read = (path: string) => readFileSync(join(skill, path), "utf8");

// These are documentation contracts, not a runtime token collector.
test("audit entry, checkpoints, and delivery share the usage procedure", () => {
  const text = read("SKILL.md");
  const start = text.indexOf("## Establish scope");
  const trace = text.indexOf("## Trace coverage");
  const deliver = text.indexOf("## Deliver");
  expect(text.slice(start, trace)).toContain("references/usage-receipts.md");
  expect(text.slice(start, trace)).toContain("checkpoint");
  expect(text.slice(deliver)).toContain("references/usage-receipts.md");
  expect(read("references/report-template.md")).toContain(
    "## Audit usage receipt",
  );
});

test("receipt examples preserve file bodies and read the exact issue back", () => {
  const text = read("references/usage-receipts.md");
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  expect(blocks).toHaveLength(3);
  const directory = mkdtempSync(join(tmpdir(), "audit-usage-docs-"));
  try {
    const body =
      "# Report\n\n<!-- audit-usage:run-fixture:begin -->\nIt's unavailable.\n";
    writeFileSync(join(directory, "report.md"), body);
    // Stub gh only: no GitHub writes, model requests, or audited application.
    const stub = `gh() {
  printf '%s\\n' "$*" >> "$receipt_dir/calls"
  case "$*" in
    'issue create --repo fixture/repo --title Fixture --body-file '*)
      cmp "$body_file" "$receipt_dir/report.md" || return 1
      printf '%s\\n' 'https://github.com/fixture/repo/issues/7' ;;
    'issue view https://github.com/fixture/repo/issues/7 --repo fixture/repo --json url,number,body')
      printf '%s\\n' '{"url":"https://github.com/fixture/repo/issues/7","number":7,"body":"fixture"}' ;;
    'issue edit https://github.com/fixture/repo/issues/7 --repo fixture/repo --body-file '*)
      cmp "$body_file" "$receipt_dir/report.md" ;;
    *) return 77 ;;
  esac
}
`;
    const result = Bun.spawnSync(
      ["sh", "-eu", "-c", `${stub}\n${blocks.join("\n")}`],
      {
        env: {
          ...process.env,
          repo: "fixture/repo",
          title: "Fixture",
          receipt_dir: directory,
          body_file: join(directory, "report.md"),
          issue_url: "https://github.com/fixture/repo/issues/7",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(join(directory, "calls"), "utf8");
    expect(calls.match(/issue create/g)).toHaveLength(1);
    expect(calls.match(/issue edit/g)).toHaveLength(1);
    expect(calls.match(/issue view/g)).toHaveLength(2);
    expect(readFileSync(join(directory, "issue-url.txt"), "utf8").trim()).toBe(
      "https://github.com/fixture/repo/issues/7",
    );
    expect(
      JSON.parse(readFileSync(join(directory, "issue-readback.json"), "utf8")),
    ).toEqual({
      url: "https://github.com/fixture/repo/issues/7",
      number: 7,
      body: "fixture",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all local audit skill links resolve", () => {
  for (const file of [
    "SKILL.md",
    "references/report-template.md",
    "references/usage-receipts.md",
  ]) {
    for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1] ?? "";
      if (target.includes("://") || target.startsWith("#")) continue;
      expect(
        Bun.file(resolve(skill, file, "..", target.split("#")[0] ?? "")).size,
      ).toBeGreaterThan(0);
    }
  }
});
