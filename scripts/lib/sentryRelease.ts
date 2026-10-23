import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  browserConfig,
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
  const artifacts = sourceMapArtifacts(directory, config.build);
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
    artifacts.urlPrefix,
    "--ext",
    "js",
    "--ext",
    "map",
    "--validate",
    "--strict",
    "--wait",
    artifacts.directory,
  ]);
}

export function sourceMapArtifacts(directory: string, build: SentryBuild) {
  const isApi = build.target === "api";
  const config = isApi
    ? undefined
    : browserConfig(
        build,
        JSON.parse(
          readFileSync(resolve(directory, "sentry-assets.json"), "utf8"),
        ),
        "",
      );
  if (!isApi && !config)
    throw new Error("Source-map manifest does not match this release.");
  const paths = isApi ? ["/index.js"] : [...(config?.paths ?? [])];
  for (const path of paths) {
    const bundle = resolve(directory, path.slice(1));
    if (!existsSync(bundle) || !existsSync(`${bundle}.map`))
      throw new Error(`Missing source map for ${path}.`);
  }
  // Static PDF worker/wasm assets are outside the diagnostic allowlist and
  // ship without maps. Upload generated JS chunks and their maps only.
  return {
    directory: isApi ? directory : resolve(directory, "assets"),
    urlPrefix: isApi ? "app:///" : "app:///assets",
  };
}

export async function removeSourceMaps(directory: string) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, file.name);
    if (file.isDirectory()) await removeSourceMaps(path);
    else if (file.name.endsWith(".map")) await rm(path);
  }
}
