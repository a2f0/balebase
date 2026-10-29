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
  // The shell wrapper dispatches assessment commands to this TypeScript entrypoint.
  entry: ["scripts/dev/scope.ts"],
  project: ["*.{css,ts,mts}", "scripts/dev/scope/**/*.ts"],
  // Installed host tools, not package-managed application dependencies.
  ignoreBinaries: ["shellcheck", "codex"],
  // The commit-msg hook runs commitlint, and the release uploader invokes the
  // Sentry CLI through runBun.
  ignoreDependencies: ["@commitlint/cli", "@sentry/cli"],
};

// Knip does not read CSS by default; surfacing @import lets it see font
// packages and stylesheet partials as used.
const compilers = {
  css: (text: string) =>
    [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)]
      .map(([, specifier]) => `import "${specifier}";`)
      .join("\n"),
};

interface PackageWorkspace {
  // The default mode's entries, including tests, and the files it checks.
  entry: string[];
  project: string[];
  // Production mode starts only from shipped code and checks no other files.
  production: string[];
  ignoreDependencies?: string[];
  includeEntryExports?: boolean;
}

const defaultPackage = {
  entry: ["src/**/*.test.ts"],
  project: ["src/**/*.{css,ts}"],
  production: ["src/**/*.ts!", "!src/**/*.test.ts"],
} satisfies PackageWorkspace;

// Knip applies the most specific matching key and does not merge it with
// "packages/*", so each override lists every setting its package needs.
const packageWorkspaces: Record<string, PackageWorkspace> = {
  "packages/*": defaultPackage,
  "packages/api": {
    ...defaultPackage,
    project: [...defaultPackage.project, "scripts/**/*.ts"],
    production: [...defaultPackage.production, "!src/testing/**"],
  },
  // Every validators file is a package entry, and knip skips unused exports
  // of entries unless told to check them.
  "packages/validators": { ...defaultPackage, includeEntryExports: true },
  "packages/app": {
    entry: ["browser/**/*.test.tsx"],
    project: ["src/**/*.{css,ts,tsx}", "browser/**/*.tsx"],
    production: ["src/**/*.{ts,tsx}!"],
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
    production: ["src/**/*.{ts,tsx}!"],
    // The generated Gradle settings expose the Android platform after sync.
    ignoreDependencies: androidBeforeSync,
  },
  "packages/app-web": {
    // The browser tests generate an entry script that imports this fixture.
    entry: ["browser/**/*.test.ts", "browser/updatesFixture.tsx"],
    project: ["src/**/*.{css,ts,tsx}", "browser/**/*.{ts,tsx}"],
    production: ["src/**/*.{ts,tsx}!"],
  },
  "packages/ui": {
    entry: ["src/**/*.test.ts"],
    project: ["src/**/*.{css,ts,tsx}"],
    // Production mode does not follow CSS @import chains, so the partials
    // that import the font packages are listed as entries themselves.
    production: ["src/styles/*.css!"],
  },
  "packages/website": {
    entry: ["src/pages/**/*.astro", "browser/**/*.test.ts"],
    project: ["src/**/*.{astro,css,ts}", "browser/**/*.ts"],
    production: ["astro.config.ts!", "src/**/*.{astro,ts}!"],
  },
};

const configFor = (production?: boolean) =>
  ({
    compilers,
    treatConfigHintsAsErrors: true,
    workspaces: {
      ".": rootToolingWorkspace,
      ...Object.fromEntries(
        Object.entries(packageWorkspaces).map(
          ([key, { production: productionEntry, ...workspace }]) => [
            key,
            production ? { entry: productionEntry, project: [] } : workspace,
          ],
        ),
      ),
    },
  }) satisfies KnipConfig;

export default ((options) =>
  configFor(options.production)) satisfies KnipConfig;
