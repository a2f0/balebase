import { resolve } from "node:path";
import {
  currentCommit,
  releaseConfiguration,
  removeSourceMaps,
  repositoryRoot,
  requireUploadEnvironment,
  runBun,
  uploadSourceMaps,
} from "../lib/sentryRelease";

const target = process.argv[2];
if (target !== "web" && target !== "android" && target !== "ios")
  throw new Error("Expected web, android, or ios.");
const { NATIVE_RELEASE_TIER, DRY_RUN } = process.env;
const environment =
  target === "web"
    ? (process.argv[3] ?? "production")
    : (NATIVE_RELEASE_TIER ?? "production");
const config = releaseConfiguration(
  target,
  environment,
  process.env,
  currentCommit(),
);
const upload = config && DRY_RUN !== "1";
if (upload) requireUploadEnvironment();
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
  if (upload) uploadSourceMaps(directory, config);
} finally {
  await removeSourceMaps(directory);
}
