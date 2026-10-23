/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plans } from "@balebase/ui/brand";
import {
  canonicalUrl,
  homeStructuredData,
  type ReleaseTier,
  releaseTier,
  scriptJson,
  searchFiles,
} from "./search";

test("the tier defaults to production and rejects unknown names", () => {
  expect(releaseTier(undefined)).toBe("production");
  expect(releaseTier(" Staging ")).toBe("staging");
  expect(() => releaseTier("prod")).toThrow("Unknown PUBLIC_RELEASE_TIER");
});

test("canonical URLs use the trailing slash the Worker serves pages at", () => {
  expect(canonicalUrl("/")).toBe("https://balebase.com/");
  expect(canonicalUrl("/privacy")).toBe("https://balebase.com/privacy/");
  expect(canonicalUrl("privacy/")).toBe("https://balebase.com/privacy/");
});

test("offers repeat the listed prices and reject one that is not a dollar amount", () => {
  const facts = {
    appUrl: "https://app.balebase.com",
    description: "Description",
    legalEntityName: "Tearleads, LLC",
    plans,
    productName: "Balebase",
  };
  const [, , app] = homeStructuredData(facts)["@graph"];
  expect(app).toMatchObject({
    url: "https://app.balebase.com/",
    operatingSystem: "Web",
    offers: [
      { name: "Free", price: "0", priceCurrency: "USD" },
      { name: "Pro", price: "10", priceCurrency: "USD" },
    ],
  });
  const [free, pro] = plans;
  expect(() =>
    homeStructuredData({ ...facts, plans: [free, { ...pro, price: "Ask" }] }),
  ).toThrow("Unexpected price for Pro");
});

test("inline JSON cannot close its script element", () => {
  expect(scriptJson({ text: "</script>" })).toBe('{"text":"\\u003c/script>"}');
});

test("only production lists a sitemap; only staging sends noindex", () => {
  const production = searchFiles("production", ["", "privacy/", "/privacy"]);
  expect(production["robots.txt"]).toBe(
    "User-agent: *\nAllow: /\n\nSitemap: https://balebase.com/sitemap.xml\n",
  );
  expect(production["sitemap.xml"]?.match(/<loc>[^<]+/g)).toEqual([
    "<loc>https://balebase.com/",
    "<loc>https://balebase.com/privacy/",
  ]);
  expect(production._headers).toBeUndefined();
  const staging = searchFiles("staging", ["", "privacy/"]);
  expect(staging["robots.txt"]).toBe("User-agent: *\nAllow: /\n");
  expect(staging["sitemap.xml"]).toBeUndefined();
  expect(staging._headers).toBe("/*\n  X-Robots-Tag: noindex, nofollow\n");
});

// The real Astro build of each tier, as the deploy scripts run it.
describe("built tiers", () => {
  const work = mkdtempSync(join(tmpdir(), "website-search-"));
  const siteRoot = fileURLToPath(new URL("..", import.meta.url));
  const out = (tier: ReleaseTier) => join(work, tier);
  const read = (tier: ReleaseTier, file: string) =>
    readFileSync(join(out(tier), file), "utf8");
  const pages = ["index.html", "privacy/index.html", "404.html"];

  beforeAll(async () => {
    for (const tier of ["production", "staging"] as const) {
      const build = Bun.spawn(
        [
          "bunx",
          "--bun",
          "--no-install",
          "astro",
          "build",
          "--outDir",
          out(tier),
        ],
        {
          cwd: siteRoot,
          env: {
            ...process.env,
            NODE_ENV: "production",
            PUBLIC_RELEASE_TIER: tier,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [code, stderr] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${tier} build failed: ${stderr}`);
    }
  }, 120_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test("production pages are canonical and never noindex", () => {
    expect(read("production", "index.html")).toContain(
      '<link rel="canonical" href="https://balebase.com/">',
    );
    expect(read("production", "privacy/index.html")).toContain(
      '<meta property="og:url" content="https://balebase.com/privacy/">',
    );
    expect(read("production", "404.html")).not.toContain("canonical");
    for (const page of pages)
      expect(read("production", page)).not.toContain("noindex");
    expect(read("production", "sitemap.xml")).not.toContain("404");
    expect(read("production", "robots.txt")).toContain("Sitemap:");
    expect(existsSync(join(out("production"), "_headers"))).toBe(false);
    const json = read("production", "index.html").match(
      /<script type="application\/ld\+json">([^<]+)<\/script>/,
    )?.[1];
    expect(JSON.parse(json ?? "")["@graph"]).toHaveLength(3);
  });

  test("staging pages and responses are noindex, with no canonical or sitemap", () => {
    for (const page of pages) {
      const html = read("staging", page);
      expect(html).toContain(
        '<meta name="robots" content="noindex, nofollow">',
      );
      expect(html).not.toContain("canonical");
    }
    expect(read("staging", "_headers")).toContain(
      "X-Robots-Tag: noindex, nofollow",
    );
    expect(read("staging", "robots.txt")).not.toContain("Sitemap");
    expect(existsSync(join(out("staging"), "sitemap.xml"))).toBe(false);
  });
});
