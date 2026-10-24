import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, launch } from "puppeteer-core";
import { build } from "vite";
import { offlineShell } from "../../app-web/offlineShell";

it("reopens the precached web shell offline without caching private API responses", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for offline shell tests.");
  const directory = mkdtempSync(join(tmpdir(), "offline-shell-"));
  const profile = mkdtempSync(join(tmpdir(), "offline-shell-browser-"));
  writeFileSync(
    join(directory, "index.html"),
    '<!doctype html><p id="status">Loading</p><script type="module" src="/entry.js"></script>',
  );
  writeFileSync(
    join(directory, "entry.js"),
    'document.querySelector("#status").textContent = "Offline shell ready"; navigator.serviceWorker.register("/offline-worker.js");',
  );
  await build({
    configFile: false,
    root: directory,
    plugins: [offlineShell()],
    logLevel: "error",
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/private")
        return Response.json({ secret: "Never cache this" });
      const file = Bun.file(
        join(
          directory,
          "dist",
          path === "/" || path === "/offline" ? "index.html" : path,
        ),
      );
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.evaluate(() =>
      navigator.serviceWorker.ready.then(() => undefined),
    );
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await page.evaluate(() =>
      fetch("/api/private").then((response) => response.json()),
    );
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys())
          urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain("/index.html");
    expect(cached.some((path) => path.endsWith(".js"))).toBe(true);
    expect(cached).not.toContain("/api/private");
    await page.setOfflineMode(true);
    await page.goto(new URL("/offline", server.url).href);
    expect(await page.$eval("#status", (element) => element.textContent)).toBe(
      "Offline shell ready",
    );
    await page.reload();
    expect(await page.$eval("#status", (element) => element.textContent)).toBe(
      "Offline shell ready",
    );
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}, 30_000);
