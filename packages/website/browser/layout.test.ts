/// <reference types="bun" />
import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import { storeBadgeHref, storeListings } from "../src/site";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = fileURLToPath(new URL("../../app-web", import.meta.url));
const pages = ["/", "/terms/", "/privacy/", "/data-retention/", "/404.html"];
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
const appDist = join(work, "app-dist");
let browser: Browser | undefined;

beforeAll(async () => {
  const build = Bun.spawn(
    ["bunx", "--bun", "--no-install", "astro", "build", "--outDir", dist],
    {
      cwd: siteRoot,
      env: { ...process.env, NODE_ENV: "production" },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Website build failed: ${stderr}`);
  // Verify both real bundler entrypoints with the same intercepted network.
  // The SDK itself remains a dependency only of the two browser shells.
  const appBuild = Bun.spawn(
    ["bunx", "--bun", "--no-install", "vite", "build", "--outDir", appDist],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        VITE_API_URL: "https://api.balebase.com",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [appExit, appOut, appError] = await Promise.all([
    appBuild.exited,
    new Response(appBuild.stdout).text(),
    new Response(appBuild.stderr).text(),
  ]);
  if (appExit !== 0)
    throw new Error(`App build failed: ${appOut}\n${appError}`);
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

async function openSite(root = dist, batches: string[] = []) {
  const page = await browser?.newPage();
  if (!page) throw new Error("Chrome did not start.");
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    const { hostname, pathname } = new URL(request.url());
    if (hostname === "ct.a2f0.net") {
      batches.push((await request.fetchPostData()) ?? "");
      await request.respond({
        status: 202,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
      return;
    }
    if (hostname === "api.balebase.com") {
      await request.respond({
        contentType: "application/json",
        body: "null",
        headers: {
          "Access-Control-Allow-Origin":
            request.headers().origin ?? "https://app.balebase.com",
          "Access-Control-Allow-Credentials": "true",
        },
      });
      return;
    }
    const file = join(
      root,
      pathname.endsWith("/") ? `${pathname}index.html` : pathname,
    );
    if (!file.startsWith(root) || !existsSync(file)) {
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

it("real Astro and Vite bundles initialize only at their deployed origins", async () => {
  for (const [origin, app, environment] of [
    ["https://balebase.com", "website", "production"],
    ["https://website-staging.balebase.com", "website", "staging"],
    ["https://website.test", "website", null],
    ["https://app.balebase.com", "web-app", "production"],
    ["https://app-staging.balebase.com", "web-app", "staging"],
    ["https://app.test", "web-app", null],
  ] as const) {
    const batches: string[] = [];
    const page = await openSite(app === "website" ? dist : appDist, batches);
    try {
      await page.evaluateOnNewDocument(() =>
        Object.defineProperty(navigator, "webdriver", { get: () => false }),
      );
      await page.goto(origin, { waitUntil: "networkidle0" });
      await page.evaluate((kind) => {
        history.replaceState(
          null,
          "",
          kind === "website"
            ? "/privacy?private=1"
            : "/me/screening/private-record",
        );
        const button = document.createElement("button");
        button.id = "tracking-smoke";
        button.textContent = "Local smoke test";
        Object.assign(button.style, {
          position: "fixed",
          top: "5px",
          left: "5px",
          zIndex: "2147483647",
        });
        document.body.append(button);
      }, app);
      await page.click("#tracking-smoke");
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForNetworkIdle({ idleTime: 100, timeout: 5_000 });
      expect({ origin, batches: batches.length }).toEqual({
        origin,
        batches: environment ? 1 : 0,
      });
      if (environment) {
        const batch = JSON.parse(batches[0] ?? "");
        expect(batch.site).toBe("balebase");
        expect(batch.environment).toBe(environment);
        expect(batch.events).toHaveLength(1);
        expect(batch.events[0]).toMatchObject({
          app,
          page: app === "website" ? "/privacy" : "/",
          target: "button",
        });
        expect(batches.join("")).not.toContain("private");
      }
    } finally {
      await page.close();
    }
  }
}, 30_000);

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

it("shows each store badge with its listing link and no tagline", async () => {
  const page = await openSite();
  await page.goto("https://website.test/", { waitUntil: "load" });
  const badges = await page.$$eval(".storeBadgeList li", (items) =>
    items.map((item) => {
      const image = item.querySelector("img");
      return {
        id: item.getAttribute("data-store"),
        alt: image?.alt,
        loaded: image?.complete && image.naturalWidth > 0,
        href: item.querySelector("a")?.getAttribute("href") ?? null,
      };
    }),
  );
  expect(badges).toEqual(
    storeListings.map((listing) => ({
      id: listing.id,
      alt: listing.label,
      loaded: true,
      href: storeBadgeHref(listing),
    })),
  );
  const text = await page.$eval(".storeBadges", (badges) =>
    badges.textContent?.trim(),
  );
  expect(text).toBe("");
});

it("draws the store badges as self-contained vector art", () => {
  for (const listing of storeListings) {
    const svg = readFileSync(join(publicRoot, listing.badge.src), "utf8");
    expect(svg).toMatch(/<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const viewBox = svg
      .match(/\bviewBox="([^"]+)"/)?.[1]
      ?.split(/\s+/)
      .map(Number);
    expect(viewBox).toHaveLength(4);
    const [, , width = 0, height = 0] = viewBox ?? [];
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(
      Math.abs((width / height) * listing.badge.height - listing.badge.width),
    ).toBeLessThan(1);
    // Text is outlined, so the badge needs no fonts, images, or links.
    expect(svg).not.toMatch(/<text|<image|href=|@font-face|url\((?!#)/);
  }
});

it("centers store badges with equal space above and below, wrapping on narrow phones", async () => {
  const page = await openSite();
  for (const [width, height] of [
    [320, 568],
    [360, 800],
    [375, 667],
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1081, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
  ] as const) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto("https://website.test/", { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const bounds = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element.getBoundingClientRect().toJSON();
      };
      return {
        header: rect(".siteHeader"),
        list: rect(".storeBadgeList"),
        apple: rect('[data-store="app-store"] img'),
        google: rect('[data-store="google-play"] img'),
        copy: rect(".heroCopy"),
        preview: rect(".businessPreview"),
        features: rect("#product .bandIntro"),
      };
    });
    expect(bounds.list.top).toBeGreaterThanOrEqual(bounds.header.bottom);
    const spaceAbove =
      bounds.list.top - Math.max(bounds.copy.bottom, bounds.preview.bottom);
    const spaceBelow = bounds.features.top - bounds.list.bottom;
    expect(spaceAbove).toBeGreaterThan(24);
    expect(Math.abs(spaceAbove - spaceBelow)).toBeLessThan(1);
    expect(
      Math.abs(bounds.list.x + bounds.list.width / 2 - width / 2),
    ).toBeLessThan(1);
    if (width < 375) {
      expect(bounds.google.top - bounds.apple.bottom).toBeGreaterThanOrEqual(
        16,
      );
      for (const badge of [bounds.apple, bounds.google]) {
        expect(Math.abs(badge.x + badge.width / 2 - width / 2)).toBeLessThan(1);
      }
    } else {
      expect(bounds.apple.top).toBe(bounds.google.top);
      expect(bounds.google.left - bounds.apple.right).toBeGreaterThanOrEqual(
        16,
      );
    }
    for (const listing of storeListings) {
      const badge = listing.id === "app-store" ? bounds.apple : bounds.google;
      expect(badge.height).toBe(50);
      expect(badge.height).toBe(listing.badge.height);
      expect(Math.abs(badge.width - listing.badge.width)).toBeLessThan(1);
    }
    expect(bounds.apple.left).toBeGreaterThanOrEqual(0);
    expect(bounds.google.right).toBeLessThanOrEqual(width);
  }
  await page.close();
}, 60_000);
