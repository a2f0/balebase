/// <reference types="bun" />
import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const pages = ["/", "/terms/", "/privacy/", "/data-retention/"];
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

it("every page fits phone and tablet widths without sideways scrolling", async () => {
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
