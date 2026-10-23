import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pdfjsAssets } from "@balebase/app/vite";
import { sentryAssets } from "@balebase/diagnostics/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

/*
 * Search engines may index only the production app. Its shell names the app
 * root as canonical, which consolidates every client route under it. A
 * staging build instead marks the shell, and through Cloudflare's _headers
 * every response, noindex, and omits the canonical link: a noindex page that
 * names production as its canonical sends conflicting signals. robots.txt
 * allows crawling on both tiers, since a crawler that may not fetch a page
 * never sees its noindex.
 */
export const appUrl = "https://app.balebase.com/";
export const noindex = "noindex, nofollow";

export type ReleaseTier = "production" | "staging";

/** The build's tier from VITE_RELEASE_TIER; production when unset. */
export function releaseTier(value: string | undefined): ReleaseTier {
  const tier = (value ?? "production").trim().toLowerCase();
  if (tier !== "production" && tier !== "staging") {
    throw new Error(
      `Unknown VITE_RELEASE_TIER=${JSON.stringify(value)}. Expected production or staging.`,
    );
  }
  return tier;
}

/**
 * buildSentryApp.ts sets VITE_RELEASE_TIER from the release's environment
 * argument; a plain `bun run build` is production.
 */
export function searchIndexing(override?: ReleaseTier): Plugin {
  const { VITE_RELEASE_TIER } = process.env;
  const tier = override ?? releaseTier(VITE_RELEASE_TIER);
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
      if (tier !== "staging" || !dir) return;
      await appendFile(
        join(dir, "_headers"),
        `\n/*\n  X-Robots-Tag: ${noindex}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), sentryAssets(), searchIndexing()],
});
