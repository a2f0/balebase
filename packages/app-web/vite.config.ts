import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pdfjsAssets } from "@balebase/app/vite";
import { type ReleaseTier, releaseTier } from "@balebase/diagnostics/config";
import { sentryAssets } from "@balebase/diagnostics/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import { offlineShell } from "./offlineShell.ts";

/*
 * Search engines may index only the production app. Its shell names the app
 * root as canonical, which consolidates every client route under it. A
 * staging build instead marks the shell, and through Cloudflare's _headers
 * every response, noindex, and omits the canonical link: a noindex page that
 * names production as its canonical sends conflicting signals. robots.txt
 * allows crawling on both tiers, since a crawler that may not fetch a page
 * never sees its noindex.
 *
 * Signing links (/sign/<token>) open a contract without an account, so
 * production sends noindex for them too: sharing a link is not consent to a
 * search listing.
 */
export const appUrl = "https://app.balebase.com/";
export const noindex = "noindex, nofollow";

/**
 * buildSentryApp.ts sets VITE_RELEASE_TIER from the release's environment
 * argument; a plain `bun run build` is production.
 */
export function searchIndexing(override?: ReleaseTier): Plugin {
  const { VITE_RELEASE_TIER } = process.env;
  const tier = override ?? releaseTier("VITE_RELEASE_TIER", VITE_RELEASE_TIER);
  const tags: HtmlTagDescriptor[] =
    tier === "production"
      ? [
          { tag: "link", attrs: { rel: "canonical", href: appUrl } },
          { tag: "meta", attrs: { property: "og:url", content: appUrl } },
        ]
      : [{ tag: "meta", attrs: { name: "robots", content: noindex } }];
  return {
    name: "balebase-search-indexing",
    apply: "build",
    transformIndexHtml: () => tags.map((tag) => ({ ...tag, injectTo: "head" })),
    // Vite copies public/_headers before writing the bundle.
    async writeBundle({ dir }) {
      if (!dir) return;
      const paths = tier === "staging" ? "/*" : "/sign/*";
      await appendFile(
        join(dir, "_headers"),
        `\n${paths}\n  X-Robots-Tag: ${noindex}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    pdfjsAssets(),
    sentryAssets(),
    searchIndexing(),
    offlineShell(),
  ],
});
