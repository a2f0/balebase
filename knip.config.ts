import { existsSync } from "node:fs";
import type { KnipConfig } from "knip";

// Knip's Capacitor plugin detects Android only from this generated file.
// Exempt the native platform on a fresh checkout, before mobile:sync creates it.
const androidBeforeSync = existsSync(
  new URL(
    "./packages/client/android/capacitor.settings.gradle",
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
    "packages/client": {
      entry: ["browser/**/*.test.tsx"],
      project: ["src/**/*.{css,ts,tsx}", "browser/**/*.tsx"],
      // cap sync registers this native plugin; its default Android back handler
      // needs no JavaScript listener and preserves our popstate navigation guard.
      ignoreDependencies: ["@capacitor/app", ...androidBeforeSync],
    },
    "packages/ui": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts,tsx}"],
    },
    "packages/website": {
      entry: ["src/pages/**/*.astro"],
      project: ["src/**/*.{astro,css,ts}"],
    },
  },
} satisfies KnipConfig;

const productionConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "packages/api": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts"],
      project: [],
    },
    "packages/client": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
      ignoreDependencies: ["@capacitor/app"],
    },
    // Production mode does not follow CSS @import chains, so the partials
    // that import the font packages are listed as entries themselves.
    "packages/ui": {
      entry: ["src/styles/*.css!"],
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
