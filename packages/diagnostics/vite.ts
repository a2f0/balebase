import type { Plugin } from "vite";
import { isSentryBuild } from "./src/config";

/** Only the release wrapper supplies this value; ordinary builds stay local. */
export function sentryAssets(): Plugin {
  const { SENTRY_BUILD_CONFIG: raw } = process.env;
  const build: unknown = raw ? JSON.parse(raw) : undefined;
  if (
    build !== undefined &&
    (!isSentryBuild(build) || build.target === "api")
  ) {
    throw new Error("Invalid Sentry browser build configuration.");
  }
  return {
    name: "sentry-assets",
    config: (_config, { command }) => {
      const active = command === "build" ? build : undefined;
      return {
        define: { __SENTRY_BUILD__: JSON.stringify(active) ?? "undefined" },
        build: { sourcemap: active ? "hidden" : false },
      };
    },
    generateBundle(_options, bundle) {
      if (!isSentryBuild(build)) return;
      this.emitFile({
        type: "asset",
        fileName: "sentry-assets.json",
        source: JSON.stringify({
          release: build.release,
          environment: build.environment,
          target: build.target,
          paths: Object.values(bundle)
            .filter((file) => file.type === "chunk")
            .map((file) => `/${file.fileName}`),
        }),
      });
    },
  };
}
