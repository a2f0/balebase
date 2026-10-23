import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  currentCommit,
  releaseConfiguration,
  repositoryRoot,
  requireUploadEnvironment,
  runBun,
  sourceMapArtifacts,
  uploadSourceMaps,
} from "../lib/sentryRelease";

const environment =
  process.argv.slice(2).find((value) => value !== "--check") ?? "production";
const workerConfig = resolve(
  repositoryRoot,
  "packages/api",
  environment === "staging" ? "wrangler.staging.jsonc" : "wrangler.jsonc",
);
const config = releaseConfiguration(
  "api",
  environment,
  process.env,
  currentCommit(),
);
const { DRY_RUN } = process.env;
const dryRun = DRY_RUN === "1";
if (config && !dryRun) requireUploadEnvironment();
if (process.argv.includes("--check")) process.exit(0);
const parent = resolve(repositoryRoot, "packages/api/.wrangler");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(resolve(parent, "sentry-"));
const wrangler = [
  "x",
  "--bun",
  "--no-install",
  "wrangler",
  "deploy",
  "--config",
  workerConfig,
];
try {
  // Build once, upload those maps, then publish the exact same module. Keeping
  // index.js as the module name makes Worker frames match app:///index.js.
  runBun([
    ...wrangler,
    "--dry-run",
    "--upload-source-maps",
    "--outdir",
    directory,
    "--define",
    `API_SENTRY_BUILD:${JSON.stringify(config?.build) ?? "undefined"}`,
  ]);
  if (config) sourceMapArtifacts(directory, config.build);
  if (!dryRun && config) uploadSourceMaps(directory, config);
  runBun([
    ...wrangler,
    resolve(directory, "index.js"),
    "--no-bundle",
    ...(dryRun ? ["--dry-run"] : []),
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
