import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Header, type HeaderData } from "tar";
import { extractArchive } from "../../dev/scope/storage";

function header(data: HeaderData) {
  const value = new Header({ mode: 0o644, size: 0, ...data });
  value.encode();
  if (!value.block) throw new Error("Missing fixture tar header");
  return value.block;
}

test("real archives reject every unsafe entry before extracting any file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-archive-test-"));
  try {
    const target = join(directory, "target");
    await mkdir(target);
    const file = join(directory, "input.tar");
    const entries: HeaderData[] = [
      { path: "../escape", type: "File" },
      { path: "link", type: "SymbolicLink", linkpath: "../escape" },
      { path: "link", type: "Link", linkpath: "../escape" },
    ];
    for (const entry of entries) {
      await writeFile(
        file,
        Buffer.concat([
          header({ path: "first", type: "File" }),
          header(entry),
          Buffer.alloc(1024),
        ]),
      );
      await expect(extractArchive(file, target)).rejects.toThrow(
        "Unsafe snapshot entries",
      );
      expect(await readdir(target)).toEqual([]);
    }
    const body = Buffer.alloc(512);
    body.write("hello");
    await writeFile(
      file,
      Buffer.concat([
        header({ path: "safe.txt", type: "File", size: 5 }),
        body,
        Buffer.alloc(1024),
      ]),
    );
    await extractArchive(file, target);
    expect(await readFile(join(target, "safe.txt"), "utf8")).toBe("hello");
    expect((await readdir(directory)).sort()).toEqual(["input.tar", "target"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("grade invokes the CLI with the sandbox, configuration and credential restrictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-cli-test-"));
  try {
    const executable = join(directory, "codex");
    await writeFile(
      executable,
      `#!${process.execPath}
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
await Bun.write("invocation.json", JSON.stringify({ args, env: process.env }));
await Bun.write(output, JSON.stringify({ results: [{ criterionId: "rule", passed: true, feedback: "fixture evidence" }] }));
`,
    );
    await chmod(executable, 0o755);
    const module = resolve(import.meta.dir, "../../dev/scope/judge/codex.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { grade } from ${JSON.stringify(module)}; await grade(process.cwd(), [{ id: "rule", prompt: "Inspect", dependsOn: [], gates: [] }]);`,
      ],
      {
        cwd: directory,
        env: {
          HOME: directory,
          PATH: directory,
          OPENAI_API_KEY: "fixture-secret",
          ANTHROPIC_API_KEY: "fixture-secret",
          SCOPE_TOKEN: "fixture-secret",
          GITHUB_TOKEN: "fixture-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    const invocation = await Bun.file(
      join(directory, "invocation.json"),
    ).json();
    for (const flag of [
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      'shell_environment_policy.inherit="none"',
      "project_doc_max_bytes=0",
      'web_search="disabled"',
    ])
      expect(invocation.args).toContain(flag);
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "SCOPE_TOKEN",
      "GITHUB_TOKEN",
    ])
      expect(invocation.env[key]).toBeUndefined();
    expect(invocation.env.HOME).toBe(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
