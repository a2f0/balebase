import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { Browser } from "playwright";
import { closeChromium, launchChromium } from "./chromium";

const types: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
let dist = "";
let browser: Browser | undefined;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "web-clicks-"));
  const build = Bun.spawn(
    ["bunx", "--bun", "--no-install", "vite", "build", "--outDir", dist],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        VITE_API_URL: "https://api.balebase.com",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`App build failed: ${stdout}\n${stderr}`);
  browser = await launchChromium();
}, 120_000);

afterAll(async () => {
  try {
    await closeChromium(browser);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

it("the real Vite bundle initializes only at the app's deployed origins", async () => {
  for (const [origin, environment] of [
    ["https://app.balebase.com", "production"],
    ["https://app-staging.balebase.com", "staging"],
    ["https://app.test", null],
  ] as const) {
    if (!browser) throw new Error("Chromium did not start.");
    // The update suite covers the offline worker. Blocking it here keeps every
    // request, including its precache, on the intercepted routes below.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const batches: string[] = [];
    const delivered = Promise.withResolvers<void>();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const { hostname, pathname } = new URL(request.url());
      if (hostname === "ct.a2f0.net") {
        batches.push(request.postData() ?? "");
        await route.fulfill({
          status: 202,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
        delivered.resolve();
        return;
      }
      if (hostname === "api.balebase.com") {
        await route.fulfill({
          contentType: "application/json",
          body: "null",
          headers: {
            "Access-Control-Allow-Origin":
              (await request.headerValue("origin")) ?? origin,
            "Access-Control-Allow-Credentials": "true",
          },
        });
        return;
      }
      const file = join(
        dist,
        pathname.endsWith("/") ? `${pathname}index.html` : pathname,
      );
      await route.fulfill(
        file.startsWith(dist) && existsSync(file)
          ? {
              contentType: types[extname(file)] ?? "application/octet-stream",
              body: readFileSync(file),
            }
          : { status: 404, body: "" },
      );
    });
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "webdriver", { get: () => false }),
    );
    const page = await context.newPage();
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        history.replaceState(null, "", "/me/screening/private-record");
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
      });
      await page.click("#tracking-smoke");
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      if (environment) await delivered.promise;
      // An unregistered origin never creates a tracker; allow a stray send to land.
      else await page.waitForTimeout(250);
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
          app: "web-app",
          page: "/",
          target: "button",
        });
        expect(batches.join("")).not.toContain("private");
      }
    } finally {
      await context.close();
    }
  }
}, 60_000);
