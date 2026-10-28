/*
 * Search-engine metadata for the marketing site. Only the production build is
 * indexable, apart from its 404 page: a staging build marks every page and
 * response noindex, omits canonical links (a noindex page naming production
 * as its canonical would send crawlers conflicting signals), and publishes no
 * sitemap. Staging still allows crawling, because a crawler that may not fetch
 * a page never sees its noindex.
 */
import type { ReleaseTier } from "@balebase/diagnostics/config";
import type { Plan } from "@balebase/ui/brand";

const siteUrl = "https://balebase.com";

const noindex = "noindex, nofollow";

/**
 * A page's robots meta, or null for a page that is indexed and canonical.
 * Staging marks every page noindex, nofollow. In production only pages kept
 * out of search carry noindex, such as the 404 page: the Worker also answers
 * its own URL, /404, with a 200. Crawlers may still follow its links.
 */
export function robotsMeta(tier: ReleaseTier, indexed: boolean): string | null {
  if (tier === "staging") return noindex;
  return indexed ? null : "noindex";
}

/** Matches the directory pages the Worker serves at a trailing slash. */
export function canonicalUrl(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(path.endsWith("/") ? path : `${path}/`, siteUrl).href;
}

export const socialImage = {
  url: `${siteUrl}/og-image.png`,
  width: 1200,
  height: 630,
};

/**
 * Files written beside the built pages: robots.txt for both tiers, the
 * sitemap for production, and a staging-wide X-Robots-Tag in _headers, which
 * Cloudflare applies to every asset and HTML response.
 */
export function searchFiles(
  tier: ReleaseTier,
  pathnames: readonly string[],
): Record<string, string> {
  const robots = ["User-agent: *", "Allow: /"];
  if (tier === "staging") {
    return {
      "robots.txt": `${robots.join("\n")}\n`,
      _headers: `/*\n  X-Robots-Tag: ${noindex}\n`,
    };
  }
  const urls = [...new Set(pathnames.map(canonicalUrl))].toSorted();
  return {
    "robots.txt": `${[...robots, "", `Sitemap: ${siteUrl}/sitemap.xml`].join("\n")}\n`,
    "sitemap.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
      "</urlset>",
      "",
    ].join("\n"),
  };
}

/** A plan's displayed price, such as "$10", as a schema.org Offer. */
function offer(plan: Plan) {
  const price = /^\$(\d+(?:\.\d{2})?)$/.exec(plan.price)?.[1];
  if (!price)
    throw new Error(`Unexpected price for ${plan.name}: ${plan.price}`);
  return {
    "@type": "Offer",
    name: plan.name,
    description: plan.description,
    price,
    priceCurrency: "USD",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price,
      priceCurrency: "USD",
      unitText: plan.cadence,
    },
  };
}

/**
 * The company that provides Balebase, as tearleads.com describes it in its own
 * JSON-LD. Repeating that Organization's `@id`, short name, URL, and logo here
 * lets search engines treat both sites as one company rather than two; keep
 * them in step with that site. The legal party, `legalName`, comes from
 * legalEntityName like every other mention of it.
 */
const provider = {
  id: "https://tearleads.com/#organization",
  name: "Tearleads",
  url: "https://tearleads.com/",
  logo: "https://tearleads.com/apple-touch-icon.png",
};

interface HomeFacts {
  appUrl: string;
  description: string;
  legalEntityName: string;
  plans: readonly Plan[];
  productName: string;
}

/**
 * The home page's JSON-LD: the providing company, the site, and the web app
 * with the prices the page lists. The native apps join operatingSystem once a
 * store lists them.
 */
export function homeStructuredData(facts: HomeFacts) {
  const organization = { "@id": provider.id };
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        ...organization,
        name: provider.name,
        legalName: facts.legalEntityName,
        url: provider.url,
        logo: provider.logo,
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        url: canonicalUrl("/"),
        name: facts.productName,
        description: facts.description,
        inLanguage: "en",
        publisher: organization,
      },
      {
        "@type": "WebApplication",
        "@id": `${siteUrl}/#app`,
        name: facts.productName,
        url: new URL(facts.appUrl).href,
        description: facts.description,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        image: socialImage.url,
        provider: organization,
        offers: facts.plans.map(offer),
      },
    ],
  };
}

/** JSON for an inline script: "<" is escaped so no value can close the tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
