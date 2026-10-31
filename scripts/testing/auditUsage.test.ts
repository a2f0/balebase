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

test("receipt examples preserve file bodies and read the exact issue back", () => {
  const text = read("references/usage-receipts.md");
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  expect(blocks).toHaveLength(3);
  const directory = mkdtempSync(join(tmpdir(), "audit usage docs "));
  try {
    const body =
      "# Report\n\n<!-- audit-usage:run-fixture:begin -->\nIt's unavailable.\n<!-- audit-usage:run-fixture:end -->\n";
    writeFileSync(join(directory, "report.md"), body);
    writeFileSync(join(directory, "expected.md"), body);
    // Stub gh only: no GitHub writes, model requests, or audited application.
    const stub = `gh() {
  printf '%s\\n' "$*" >> "$receipt_dir/calls"
  case "$*" in
    'issue create --repo fixture/repo --title Fixture --body-file '*)
      test "$#" = 8 || return 1
      cmp "$8" "$receipt_dir/expected.md" || return 1
      printf '%s\\n' 'https://github.com/fixture/repo/issues/7' ;;
    'issue view https://github.com/fixture/repo/issues/7 --repo fixture/repo --json url,number,body')
      printf '%s\\n' "$response_json" ;;
    'issue edit https://github.com/fixture/repo/issues/7 --repo fixture/repo --body-file '*)
      test "$#" = 7 || return 1
      cmp "$7" "$receipt_dir/expected.md" ;;
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
          response_json: JSON.stringify({
            url: "https://github.com/fixture/repo/issues/7",
            number: 7,
            body,
          }),
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
      body,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["edit", "view"])(
  "a failed %s retains the body without recreating the issue",
  (failure) => {
    const blocks = [
      ...read("references/usage-receipts.md").matchAll(/```sh\n([\s\S]*?)```/g),
    ];
    const update = blocks[2]?.[1] ?? "";
    expect(update).toContain("gh issue edit");
    const directory = mkdtempSync(join(tmpdir(), "audit-usage-failure-"));
    try {
      const bodyFile = join(directory, "report.md");
      writeFileSync(bodyFile, "Pending receipt remains private.\n");
      const result = Bun.spawnSync(
        [
          "sh",
          "-eu",
          "-c",
          `gh() {
  printf '%s\\n' "$*" >> "$receipt_dir/calls"
  test "$1" = issue || return 99
  test "$2" != "$failure" || return 23
  test "$2" = edit || return 99
}
${update}`,
        ],
        {
          env: {
            ...process.env,
            failure,
            receipt_dir: directory,
            body_file: bodyFile,
            repo: "fixture/repo",
            issue_url: "https://github.com/fixture/repo/issues/7",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(23);
      expect(readFileSync(bodyFile, "utf8")).toBe(
        "Pending receipt remains private.\n",
      );
      const calls = readFileSync(join(directory, "calls"), "utf8");
      expect(calls).not.toContain("issue create");
      expect(calls.match(/issue edit/g)).toHaveLength(1);
      expect(calls.match(/issue view/g) ?? []).toHaveLength(
        failure === "edit" ? 0 : 1,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("all local audit skill links resolve", () => {
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
