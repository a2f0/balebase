import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, launch, type Page } from "puppeteer-core";
import { build } from "vite";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import type {} from "./offlineAppFixture";

/**
 * Builds the offline app fixture, serves it with `api` answering /api/
 * requests, and runs `run` against it in Chrome.
 */
export async function withOfflineBrowser(
  run: (page: Page, browser: Browser, directory: string) => Promise<void>,
  api: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ error: "Not available" }, { status: 503 }),
) {
  const directory = mkdtempSync(join(tmpdir(), "offline-editing-"));
  await build({
    configFile: false,
    logLevel: "warn",
    oxc: { jsx: { development: false } },
    build: {
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      lib: {
        entry: new URL("./offlineAppFixture.tsx", import.meta.url).pathname,
        formats: ["es"],
        fileName: () => "fixture.js",
      },
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.VITE_API_URL": '""',
      "import.meta.env.PROD": "false",
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) return api(request);
      const file = Bun.file(join(directory, "dist", path));
      if (await file.exists()) return new Response(file);
      return new Response(
        '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean(window.offlineTest));
    await run(page, browser, directory);
  } finally {
    await closeChrome(browser);
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Clicks the enabled button labelled `label` once it appears. */
export async function press(page: Page, label: string) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === text && !button.disabled,
      ),
    { polling: 100 },
    label,
  );
  await page.evaluate(
    (text) =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === text)
        ?.click(),
    label,
  );
}
