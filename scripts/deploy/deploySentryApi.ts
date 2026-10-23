import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  currentCommit,
  releaseConfiguration,
  repositoryRoot,
  requireUploadEnvironment,
  runBun,
  uploadSourceMaps,
} from "../lib/sentryRelease";

const environment = process.argv[2] ?? "production";
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
    "--outdir",
    directory,
    "--define",
    `API_SENTRY_BUILD:${JSON.stringify(config?.build) ?? "undefined"}`,
  ]);
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
