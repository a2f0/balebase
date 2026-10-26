import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "tar";
import { register } from "../../dev/scope/register";
import { seedCriteria, validateSuite } from "../../dev/scope/suites";

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "scope-register-test-"));
  const directory = join(repository, ".scope");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  await writeFile(join(repository, ".gitignore"), ".scope/\n.secret\n");
  await writeFile(join(repository, "README.md"), "committed source\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  await writeFile(join(repository, "README.md"), "uncommitted edit\n");
  await writeFile(join(repository, ".secret"), "fixture secret\n");
  await writeFile(join(repository, "untracked.txt"), "untracked\n");
  await mkdir(directory);
  await writeFile(join(directory, "config.json"), "previous configuration\n");
  await chmod(join(directory, "config.json"), 0o644);
  return { repository, directory, commit };
}

for (const existing of [false, true]) {
  test(`registration ${existing ? "reuses" : "creates"} project/codebase and archives only committed files`, async () => {
    const context = await fixture();
    const calls: string[] = [];
    try {
      await register("HEAD", {
        ...context,
        request: async (path, body) => {
          calls.push(`${body === undefined ? "GET" : "POST"} ${path}`);
          if (path === "/projects")
            return body
              ? { _id: "project/id" }
              : existing
                ? [{ _id: "project/id", name: "Balebase" }]
                : [];
          if (body === undefined)
            return existing
              ? [
                  {
                    _id: "codebase/id",
                    name: "balebase",
                    sourceType: "archive",
                  },
                ]
              : [];
          expect(body).toBeInstanceOf(FormData);
          const form = body as FormData;
          expect(form.get("archive")).toBeInstanceOf(Blob);
          expect(form.get("name")).toBe(existing ? null : "balebase");
          return existing
            ? { _id: "revision" }
            : { _id: "codebase/id", latestRevisionId: "revision" };
        },
      });
      expect(calls).toEqual(
        existing
          ? [
              "GET /projects",
              "GET /codebases?projectId=project%2Fid",
              "POST /codebases/codebase%2Fid/upload",
            ]
          : [
              "GET /projects",
              "POST /projects",
              "GET /codebases?projectId=project%2Fid",
              "POST /codebases?projectId=project%2Fid",
            ],
      );
      const config = await Bun.file(
        join(context.directory, "config.json"),
      ).json();
      expect(config).toMatchObject({
        commit: context.commit,
        projectId: "project/id",
        codebaseId: "codebase/id",
        revisionId: "revision",
      });
      expect(
        (await stat(join(context.directory, "config.json"))).mode & 0o077,
      ).toBe(0);
      const entries: string[] = [];
      let source = "";
      await t({
        file: join(context.directory, "balebase.tar.gz"),
        onReadEntry(entry) {
          entries.push(entry.path);
          if (entry.path === "README.md")
            entry.on("data", (chunk) => {
              source += chunk.toString();
            });
        },
      });
      expect(entries.sort()).toEqual([".gitignore", "README.md"]);
      expect(source).toBe("committed source\n");
    } finally {
      await rm(context.repository, { recursive: true, force: true });
    }
  });
}

test("registration rejects ambiguous projects, ambiguous/non-archive codebases, missing revisions and API failures without replacing config", async () => {
  const context = await fixture();
  const project = { _id: "p", name: "Balebase" };
  const codebase = { _id: "c", name: "balebase", sourceType: "archive" };
  try {
    for (const [projects, codebases, error] of [
      [[project, project], [], "Multiple Balebase projects"],
      [[project], [codebase, codebase], "Multiple balebase codebases"],
      [
        [project],
        [{ ...codebase, sourceType: "git" }],
        "Expected archive codebase",
      ],
      [[project], [], "without a revision ID"],
    ] as const) {
      await expect(
        register("HEAD", {
          ...context,
          request: async (path, body) => {
            if (path === "/projects") return projects;
            return body ? { _id: "created" } : codebases;
          },
        }),
      ).rejects.toThrow(error);
      expect(
        await readFile(join(context.directory, "config.json"), "utf8"),
      ).toBe("previous configuration\n");
    }
    await expect(
      register("HEAD", {
        ...context,
        request: async () => {
          throw new Error("API unavailable");
        },
      }),
    ).rejects.toThrow("API unavailable");
    expect(await readFile(join(context.directory, "config.json"), "utf8")).toBe(
      "previous configuration\n",
    );
  } finally {
    await rm(context.repository, { recursive: true, force: true });
  }
});

test("criterion seeding reuses exact definitions, creates missing ones and refuses version drift", async () => {
  const suite = validateSuite({
    id: "suite",
    description: "fixture",
    criteria: [{ id: "rule", prompt: "Inspect", dependsOn: [], gates: [] }],
    tasks: [{ id: "task", prompt: "Inspect", criteria: ["rule"] }],
  });
  const writes: unknown[] = [];
  const paths: string[] = [];
  const request =
    (existing: unknown[]) => async (path: string, body?: unknown) => {
      paths.push(path);
      if (body !== undefined) writes.push(body);
      return existing;
    };
  await seedCriteria(suite, {
    projectId: "p/id",
    request: request(suite.criteria),
  });
  expect(writes).toEqual([]);
  await seedCriteria(suite, { projectId: "p/id", request: request([]) });
  expect(writes).toEqual(suite.criteria);
  await expect(
    seedCriteria(suite, {
      projectId: "p/id",
      request: request([{ ...suite.criteria[0], prompt: "Changed" }]),
    }),
  ).rejects.toThrow("use a new versioned ID");
  expect(writes).toEqual(suite.criteria);
  expect(new Set(paths)).toEqual(new Set(["/criteria?projectId=p%2Fid"]));
});
