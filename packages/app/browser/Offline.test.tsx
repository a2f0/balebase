import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, launch } from "puppeteer-core";
import type {} from "./offlineFixture";

it("persists audits and photos across reload, retries in dependency order, and isolates tabs and accounts", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for offline storage tests.");
  const build = await Bun.build({
    entrypoints: [new URL("./offlineFixture.tsx", import.meta.url).pathname],
    target: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"VITE_API_URL":"","PROD":false}',
    },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const script = await build.outputs[0]?.text();
  const requests: string[] = [];
  const received = new Set<string>();
  let loseResponse = true;
  let deny = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/api/offline/operations") {
        const { operation } = (await request.json()) as {
          operation: { type: string; id: string };
        };
        requests.push(operation.type);
        if (deny)
          return Response.json(
            { error: "Original account required" },
            { status: 403 },
          );
        received.add(operation.id);
        if (loseResponse) {
          loseResponse = false;
          return Response.json(
            { error: "Response lost after commit" },
            { status: 503 },
          );
        }
        return Response.json({ resourceId: operation.id });
      }
      if (path.includes("/images/")) {
        requests.push("image");
        received.add(path.split("/").at(-1) ?? "");
        expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual(
          [1, 2, 3, 4],
        );
        return Response.json({ image: { id: "image" } });
      }
      return new Response(
        '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const profile = mkdtempSync(join(tmpdir(), "offline-browser-"));
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 20_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean(window.offlineTest));
    const auditId = await page.evaluate(() => window.offlineTest.seed());
    await page.setOfflineMode(true);
    await page.evaluate(async (id) => {
      await window.offlineTest.answer(id, "fail");
      await window.offlineTest.issue(id);
    }, auditId);
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.audits[0]
        ?.responses,
    ).toEqual({ check: "fail" });
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toEqual([]);
    await page.setOfflineMode(false);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.offlineTest));
    const restored = await page.evaluate(() => window.offlineTest.read());
    expect(restored?.issues).toHaveLength(1);
    expect(restored?.audits[0]?.responses).toEqual({ check: "fail" });
    const imageId = restored?.issues[0]?.images[0]?.id;
    if (!imageId) throw new Error("Image was not persisted");
    expect(
      await page.evaluate((id) => window.offlineTest.photo(id), imageId),
    ).toEqual({ type: "image/png", bytes: [1, 2, 3, 4] });
    expect(
      await page.evaluate(() => window.offlineTest.other()),
    ).toBeUndefined();
    await page.evaluate(() =>
      window.offlineTest.abort().catch(() => undefined),
    );
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.templates,
    ).toHaveLength(1);
    // The audit has not been submitted; its children must stay waiting.
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toEqual([]);
    await page.evaluate((id) => window.offlineTest.queue(id), auditId);
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toEqual(["audit"]);
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.every(
        (job) => job.status === "pending",
      ),
    ).toBe(true);
    await page.evaluate(() => window.offlineTest.retry());
    const otherTab = await browser.newPage();
    await otherTab.goto(server.url.href);
    await otherTab.waitForFunction(() => Boolean(window.offlineTest));
    await Promise.all([
      page.evaluate(() => window.offlineTest.sync()),
      otherTab.evaluate(() => window.offlineTest.sync()),
    ]);
    expect(requests).toEqual(["audit", "audit", "issue", "image"]);
    expect(received.size).toBe(3);
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.every(
        (job) => job.status === "synced",
      ),
    ).toBe(true);
    // A different authenticated account cannot drain the saved account's work.
    deny = true;
    await page.evaluate(() => window.offlineTest.issue());
    await page.evaluate(() => window.offlineTest.sync());
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.filter(
        (job) => job.status === "blocked",
      ),
    ).toHaveLength(1);
    const count = requests.length;
    await page.evaluate(() => {
      window.offlineTest.lock();
      return window.offlineTest.retry();
    });
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toHaveLength(count);
    await page.bringToFront();
    await page.evaluate(() => {
      window.offlineTest.activate();
      window.offlineTest.mount();
    });
    await page.waitForFunction(() =>
      document.body.textContent?.includes("Broken rail"),
    );
    expect(
      await page.$$eval("img", (images) =>
        images.every((image) => image.src.startsWith("blob:")),
      ),
    ).toBe(true);
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}, 30_000);
