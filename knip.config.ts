import { existsSync } from "node:fs";
import type { KnipConfig } from "knip";

// Knip's Capacitor plugin detects Android only from this generated file.
// Exempt the native platform on a fresh checkout, before mobile:sync creates it.
const androidBeforeSync = existsSync(
  new URL(
    "./packages/app-capacitor/android/capacitor.settings.gradle",
    import.meta.url,
  ),
)
  ? []
  : ["@capacitor/android"];

const rootToolingWorkspace = {
  project: ["*.{css,ts,mts}"],
  ignoreBinaries: ["shellcheck"],
};

// Knip does not read CSS by default; surfacing @import lets it see font
// packages and stylesheet partials as used.
const compilers = {
  css: (text: string) =>
    [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)]
      .map(([, specifier]) => `import "${specifier}";`)
      .join("\n"),
};

const baseConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "packages/api": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts}"],
    },
    "packages/api-client": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts}"],
    },
    "packages/app": {
      entry: ["browser/**/*.test.tsx"],
      project: ["src/**/*.{css,ts,tsx}", "browser/**/*.tsx"],
    },
    "packages/app-capacitor": {
      entry: ["browser/**/*.test.tsx"],
      project: [
        "src/**/*.{css,ts,tsx}",
        "browser/**/*.{ts,tsx}",
        "tests/**/*.ts",
        "fastlane/**/*.ts",
        "scripts/**/*.ts",
      ],
      // cap sync registers this native plugin; its default Android back handler
      // needs no JavaScript listener and preserves our popstate navigation guard.
      ignoreDependencies: ["@capacitor/app", ...androidBeforeSync],
    },
    "packages/app-web": {
      project: ["src/**/*.{css,ts,tsx}"],
    },
    "packages/ui": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts,tsx}"],
    },
    "packages/validators": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts}"],
    },
    "packages/website": {
      entry: ["src/pages/**/*.astro", "browser/**/*.test.ts"],
      project: ["src/**/*.{astro,css,ts}", "browser/**/*.ts"],
    },
  },
} satisfies KnipConfig;

const productionConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "packages/api": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts", "!src/contractTestSetup.ts"],
      project: [],
    },
    "packages/api-client": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts"],
      project: [],
    },
    "packages/app": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
    },
    "packages/app-capacitor": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
      ignoreDependencies: ["@capacitor/app"],
    },
    "packages/app-web": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
    },
    // Production mode does not follow CSS @import chains, so the partials
    // that import the font packages are listed as entries themselves.
    "packages/ui": {
      entry: ["src/styles/*.css!"],
      project: [],
    },
    "packages/validators": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts"],
      project: [],
    },
    "packages/website": {
      entry: ["astro.config.ts!", "src/**/*.{astro,ts}!"],
      project: [],
    },
  },
} satisfies KnipConfig;

export default ((options) =>
  options.production ? productionConfig : baseConfig) satisfies KnipConfig;
