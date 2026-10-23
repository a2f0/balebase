import { resolve } from "node:path";
import {
  currentCommit,
  releaseConfiguration,
  removeSourceMaps,
  repositoryRoot,
  requireUploadEnvironment,
  runBun,
  sourceMapArtifacts,
  uploadSourceMaps,
} from "../lib/sentryRelease";

const args = process.argv.slice(2).filter((argument) => argument !== "--check");
const target = args[0];
if (target !== "web" && target !== "android" && target !== "ios")
  throw new Error("Expected web, android, or ios.");
const { NATIVE_RELEASE_TIER, DRY_RUN } = process.env;
const environment =
  target === "web"
    ? (args[1] ?? "production")
    : (NATIVE_RELEASE_TIER ?? "production").trim().toLowerCase();
const config = releaseConfiguration(
  target,
  environment,
  process.env,
  currentCommit(),
);
const upload = config && DRY_RUN !== "1";
if (upload) requireUploadEnvironment();
if (process.argv.includes("--check")) process.exit(0);
const cwd = resolve(
  repositoryRoot,
  "packages",
  target === "web" ? "app-web" : "app-capacitor",
);
const env: NodeJS.ProcessEnv & {
  SENTRY_BUILD_CONFIG?: string;
  SENTRY_AUTH_TOKEN?: string;
} = { ...process.env };
delete env.SENTRY_BUILD_CONFIG;
if (config) env.SENTRY_BUILD_CONFIG = JSON.stringify(config.build);
// No upload credentials are inherited by Vite or substituted into application code.
delete env.SENTRY_AUTH_TOKEN;
runBun(["run", "build"], cwd, env);
const directory = resolve(cwd, "dist");
try {
  if (config) sourceMapArtifacts(directory, config.build);
  if (upload) uploadSourceMaps(directory, config);
} finally {
  await removeSourceMaps(directory);
}
