/// <reference types="bun" />
import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  storeBadgeHref,
  storeComingSoonNote,
  storeListings,
} from "../src/site";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const pages = ["/", "/terms/", "/privacy/", "/data-retention/"];
const publicRoot = join(siteRoot, "public");
const types: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const work = mkdtempSync(join(tmpdir(), "website-layout-"));
const dist = join(work, "dist");
let browser: Browser | undefined;

beforeAll(async () => {
  const build = Bun.spawn(
    ["bunx", "--bun", "--no-install", "astro", "build", "--outDir", dist],
    { cwd: siteRoot, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Website build failed: ${stderr}`);
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the website layout check.");
  browser = await launch({
    executablePath: chrome,
    headless: true,
    pipe: true,
    userDataDir: join(work, "profile"),
    timeout: 10_000,
    protocolTimeout: 10_000,
    args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  rmSync(work, { recursive: true, force: true });
});

async function openSite() {
  const page = await browser?.newPage();
  if (!page) throw new Error("Chrome did not start.");
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    const file = join(
      dist,
      pathname.endsWith("/") ? `${pathname}index.html` : pathname,
    );
    if (!file.startsWith(dist) || !existsSync(file)) {
      void request.respond({ status: 404, body: "" });
      return;
    }
    void request.respond({
      contentType: types[extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });
  return page;
}

it("every page fits phone and tablet widths without sideways scrolling", async () => {
  const page = await openSite();
  const results = [];
  for (const path of pages) {
    for (const width of [320, 375, 768]) {
      await page.setViewport({
        width,
        height: 800,
        isMobile: true,
        hasTouch: true,
      });
      await page.goto(`https://website.test${path}`, { waitUntil: "load" });
      results.push({
        path,
        width,
        sideways: await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      });
    }
  }
  expect(results.filter((result) => result.sideways > 0)).toEqual([]);
}, 60_000);

it("keeps the space before an inline heading accent", () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  // HTML compression drops a bare line break before an inline element.
  expect(html).toContain("From the bank statement <span");
});

it("shows each store badge with the link and note its listing calls for", async () => {
  const page = await openSite();
  await page.goto("https://website.test/", { waitUntil: "load" });
  const badges = await page.$$eval(".storeBadgeList li", (items) =>
    items.map((item) => {
      const image = item.querySelector("img");
      return {
        id: item.getAttribute("data-store"),
        alt: image?.alt,
        loaded: [image?.naturalWidth, image?.naturalHeight],
        href: item.querySelector("a")?.getAttribute("href") ?? null,
      };
    }),
  );
  expect(badges).toEqual(
    storeListings.map((listing) => ({
      id: listing.id,
      alt: listing.label,
      loaded: [listing.badge.width, listing.badge.height],
      href: storeBadgeHref(listing),
    })),
  );
  const note = await page.$eval(
    ".storeBadges",
    (badges) =>
      badges.querySelector(".storeBadgeNote")?.textContent?.trim() ?? null,
  );
  expect(note).toBe(storeComingSoonNote(storeListings));
});

it("draws the store badges as self-contained vector art", () => {
  for (const listing of storeListings) {
    const svg = readFileSync(join(publicRoot, listing.badge.src), "utf8");
    expect(svg).toStartWith(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${listing.badge.width}" height="${listing.badge.height}"`,
    );
    // Text is outlined, so the badge needs no fonts, images, or links.
    expect(svg).not.toMatch(/<text|<image|href=|@font-face|url\((?!#)/);
  }
});
