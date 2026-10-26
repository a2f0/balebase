import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { apiRequest, root, settings, stateDir } from "./settings";
import { configSchema } from "./types";

const entity = z.object({
  _id: z.string(),
  name: z.string().optional(),
  sourceType: z.string().optional(),
  latestRevisionId: z.string().optional(),
});

export function git(...args: string[]): string {
  return gitAt(root, ...args);
}

function gitAt(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

/** Upload committed source only; ignored credentials and local state never enter the archive. */
export async function register(
  ref: string,
  { request = apiRequest, repository = root, directory = stateDir } = {},
): Promise<void> {
  const commit = gitAt(
    repository,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  );
  const projects = z.array(entity).parse(await request("/projects"));
  const matches = projects.filter((project) => project.name === "Balebase");
  if (matches.length > 1) throw new Error("Multiple Balebase projects found");
  const project =
    matches[0] ??
    entity.parse(
      await request("/projects", {
        name: "Balebase",
        description:
          "Local repository discoverability probes: Claude Code with a calibrated Codex Judge.",
      }),
    );
  const query = `?projectId=${encodeURIComponent(project._id)}`;
  const codebases = z.array(entity).parse(await request(`/codebases${query}`));
  const existing = codebases.filter((codebase) => codebase.name === "balebase");
  if (existing.length > 1) throw new Error("Multiple balebase codebases found");
  const codebase = existing[0];
  if (codebase && codebase.sourceType !== "archive")
    throw new Error("Expected archive codebase");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const archive = join(directory, "balebase.tar.gz");
  gitAt(
    repository,
    "archive",
    "--format=tar.gz",
    `--output=${archive}`,
    commit,
  );
  const form = new FormData();
  form.set("archive", Bun.file(archive), "balebase.tar.gz");
  let codebaseId: string;
  let revisionId: string | undefined;
  if (codebase) {
    const revision = entity.parse(
      await request(
        `/codebases/${encodeURIComponent(codebase._id)}/upload`,
        form,
      ),
    );
    codebaseId = codebase._id;
    revisionId = revision._id;
  } else {
    form.set("name", "balebase");
    form.set("sourceType", "archive");
    form.set(
      "description",
      "Committed source snapshots from the local checkout.",
    );
    const created = entity.parse(await request(`/codebases${query}`, form));
    codebaseId = created._id;
    revisionId = created.latestRevisionId;
    if (!revisionId)
      throw new Error(
        "Scope created the codebase without a revision ID; inspect it before retrying registration",
      );
  }
  const config = configSchema.parse({
    apiUrl: settings.apiUrl,
    projectId: project._id,
    codebaseId,
    revisionId,
    commit,
  });
  await writeFile(
    join(directory, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `Registered ${commit} at ${settings.apiUrl}; revision ${config.revisionId}`,
  );
}
