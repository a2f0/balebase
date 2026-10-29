import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, launch } from "puppeteer-core";
import { build } from "vite";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { offlineShell } from "../../app-web/offlineShell";

it.each(["direct", "redirected"])(
  "reopens the precached web shell without caching private API responses (%s HTML)",
  async (html) => {
    const redirectHtml = html === "redirected";
    const directory = mkdtempSync(join(tmpdir(), "offline-shell-"));
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
    let unavailableStatus: number | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // Cloudflare's default HTML handling redirects /index.html to /.
        if (redirectHtml && path === "/index.html")
          return Response.redirect(new URL("/", request.url).href, 307);
        if (unavailableStatus && path === "/offline")
          return new Response("Hosting unavailable", {
            status: unavailableStatus,
          });
        if (path === "/api/private")
          return Response.json({ secret: "Never cache this" });
        const file = Bun.file(
          join(
            directory,
            "dist",
            ["/", "/offline", "/root/users"].includes(path)
              ? "index.html"
              : path,
          ),
        );
        return (await file.exists())
          ? new Response(file)
          : new Response("Not found", { status: 404 });
      },
    });
    let browser: Browser | undefined;
    try {
      browser = await launch(chromeLaunchOptions());
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
      expect(
        await page.evaluate(
          async () => (await caches.match("/index.html"))?.redirected,
        ),
      ).toBe(redirectHtml);
      const nestedUrl = new URL("/root/users", server.url).href;
      const nested = await page.goto(nestedUrl);
      expect(nested?.status()).toBe(200);
      expect(page.url()).toBe(nestedUrl);
      expect(
        await page.$eval("#status", (element) => element.textContent),
      ).toBe("Offline shell ready");
      for (const status of [502, 503]) {
        unavailableStatus = status;
        const response = await page.goto(new URL("/offline", server.url).href);
        expect(response?.status()).toBe(200);
        expect(
          await page.$eval("#status", (element) => element.textContent),
        ).toBe("Offline shell ready");
      }
      unavailableStatus = undefined;
      await page.setOfflineMode(true);
      await page.goto(nestedUrl);
      expect(page.url()).toBe(nestedUrl);
      expect(
        await page.$eval("#status", (element) => element.textContent),
      ).toBe("Offline shell ready");
      await page.reload();
      expect(
        await page.$eval("#status", (element) => element.textContent),
      ).toBe("Offline shell ready");
    } finally {
      await closeChrome(browser);
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it("keeps navigation on the active shell until a waiting upgrade activates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "offline-upgrade-"));
  async function buildVersion(version: string) {
    const root = join(directory, version);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(root);
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><p id="status">Loading</p><script type="module" src="/entry.js"></script>',
    );
    writeFileSync(
      join(root, "entry.js"),
      `document.querySelector("#status").textContent = ${JSON.stringify(version)}; navigator.serviceWorker.register("/offline-worker.js", { scope: "/app/" });`,
    );
    await build({
      configFile: false,
      root,
      plugins: [offlineShell()],
      logLevel: "error",
    });
    return join(root, "dist");
  }
  let serving = await buildVersion("Version A");
  const upgraded = await buildVersion("Version B");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/observer")
        return new Response("<!doctype html><p>Upgrade observer</p>", {
          headers: { "content-type": "text/html" },
        });
      const file = Bun.file(
        join(serving, path === "/app/" ? "index.html" : path),
      );
      return (await file.exists())
        ? new Response(file, { headers: { "cache-control": "no-store" } })
        : new Response("Not found", { status: 404 });
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    await page.goto(new URL("/app/", server.url).href);
    await page.evaluate(() =>
      navigator.serviceWorker.ready.then(() => undefined),
    );
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    expect(await page.$eval("#status", (element) => element.textContent)).toBe(
      "Version A",
    );
    serving = upgraded;
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.ready).update();
    });
    await page.waitForFunction(
      async () =>
        (await navigator.serviceWorker.ready).waiting?.state === "installed",
    );
    // Online reloads must not run B under A's worker, then roll back to A offline.
    await page.reload();
    expect(await page.$eval("#status", (element) => element.textContent)).toBe(
      "Version A",
    );
    await page.setOfflineMode(true);
    await page.reload();
    expect(await page.$eval("#status", (element) => element.textContent)).toBe(
      "Version A",
    );
    // Observe the waiting worker from outside its scope while all app tabs close.
    const observer = await browser.newPage();
    await observer.goto(new URL("/observer", server.url).href);
    await observer.evaluate(async () =>
      Reflect.set(
        window,
        "waitingWorker",
        (await navigator.serviceWorker.getRegistration("/app/"))?.waiting,
      ),
    );
    await page.close();
    await observer.waitForFunction(
      () =>
        (Reflect.get(window, "waitingWorker") as ServiceWorker | undefined)
          ?.state === "activated",
    );
    const reopened = await browser.newPage();
    await reopened.setOfflineMode(true);
    await reopened.goto(new URL("/app/", server.url).href);
    expect(
      await reopened.$eval("#status", (element) => element.textContent),
    ).toBe("Version B");
    expect(await reopened.evaluate(() => caches.keys())).toHaveLength(1);
  } finally {
    await closeChrome(browser);
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
