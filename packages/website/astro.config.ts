import { writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import { releaseTier, searchFiles } from "./src/search";

// The deploy scripts set the tier; pages read this validated value, so the
// layout's robots meta and the files below always agree.
const { PUBLIC_RELEASE_TIER } = process.env;
const tier = releaseTier(PUBLIC_RELEASE_TIER);

export default defineConfig({
  output: "static",
  vite: {
    define: { "import.meta.env.PUBLIC_RELEASE_TIER": JSON.stringify(tier) },
  },
  integrations: [
    {
      name: "balebase:search-files",
      hooks: {
        "astro:build:done": async ({ dir, pages }) => {
          // The 404 page is served for unknown paths and is not a sitemap URL.
          const listed = pages
            .map((page) => page.pathname)
            .filter((pathname) => pathname.replace(/\/$/, "") !== "404");
          for (const [file, contents] of Object.entries(
            searchFiles(tier, listed),
          ))
            await writeFile(new URL(file, dir), contents);
        },
      },
    },
  ],
});
