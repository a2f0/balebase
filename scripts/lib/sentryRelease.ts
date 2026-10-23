import { execFileSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type DiagnosticTarget,
  isHostedSentryDsn,
  type SentryBuild,
} from "../../packages/diagnostics/src/config";

export const repositoryRoot = resolve(import.meta.dir, "../..");

export function releaseConfiguration(
  target: DiagnosticTarget,
  environment: string,
  env: NodeJS.ProcessEnv,
  commit: string,
) {
  if (environment !== "staging" && environment !== "production")
    throw new Error("Unknown Sentry release environment.");
  const prefix = target === "web" ? "SENTRY" : `SENTRY_${target.toUpperCase()}`;
  const key = `${prefix}_${environment.toUpperCase()}`;
  const dsn = env[`${key}_DSN`];
  if (!dsn) return undefined;
  if (!isHostedSentryDsn(dsn) || !/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("Invalid Sentry DSN or release commit.");
  const project = env[`${key}_PROJECT`];
  if (project !== `balebase-${target}-${environment}`)
    throw new Error(
      `Expected ${key}_PROJECT=balebase-${target}-${environment}.`,
    );
  const build: SentryBuild = {
    dsn,
    target,
    environment,
    release: `balebase-${target}@${commit}`,
  };
  return { build, project };
}

export function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function requireUploadEnvironment(env = process.env) {
  const { SENTRY_ORG, SENTRY_AUTH_TOKEN } = env;
  if (!SENTRY_ORG || !SENTRY_AUTH_TOKEN)
    throw new Error(
      "SENTRY_ORG and SENTRY_AUTH_TOKEN are required for source-map upload.",
    );
  if (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim()
  ) {
    throw new Error(
      "Sentry releases require a clean checkout so maps match the release commit.",
    );
  }
}

export function runBun(
  args: string[],
  cwd = repositoryRoot,
  env = process.env,
) {
  execFileSync(process.execPath, args, { cwd, env, stdio: "inherit" });
}

export function uploadSourceMaps(
  directory: string,
  config: NonNullable<ReturnType<typeof releaseConfiguration>>,
) {
  const { SENTRY_ORG } = process.env;
  runBun([
    "x",
    "--bun",
    "--no-install",
    "sentry-cli",
    "sourcemaps",
    "upload",
    "--org",
    SENTRY_ORG ?? "",
    "--project",
    config.project,
    "--release",
    config.build.release,
    "--dist",
    config.build.environment,
    "--url-prefix",
    "app:///",
    "--validate",
    "--strict",
    "--wait",
    directory,
  ]);
}

export async function removeSourceMaps(directory: string) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, file.name);
    if (file.isDirectory()) await removeSourceMaps(path);
    else if (file.name.endsWith(".map")) await rm(path);
  }
}
