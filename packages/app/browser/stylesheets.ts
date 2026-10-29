import { readFileSync } from "node:fs";

const read = (url: URL) => readFileSync(url, "utf8");

/**
 * Joins `@balebase/ui` stylesheets, then the app's, named by file without
 * `.css`, in the order a page loads them.
 */
export function stylesheets(
  ui: readonly string[],
  app: readonly string[] = [],
): string {
  return [
    ...ui.map((name) =>
      read(new URL(`../../ui/src/styles/${name}.css`, import.meta.url)),
    ),
    ...app.map((name) =>
      read(new URL(`../src/styles/${name}.css`, import.meta.url)),
    ),
  ].join("\n");
}
