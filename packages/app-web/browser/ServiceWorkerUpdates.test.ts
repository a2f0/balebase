import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, type Page, webkit } from "playwright";
import { build } from "vite";
import { offlineShell } from "../offlineShell";

async function buildVersion(directory: string, version: string) {
  const root = join(directory, version);
  await mkdir(root);
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/entry.jsx"></script>',
  );
  await writeFile(
    join(root, "entry.jsx"),
    `import { mount } from ${JSON.stringify(resolve(import.meta.dir, "updatesFixture.tsx"))}; mount(${JSON.stringify(version)});`,
  );
  await build({
    configFile: false,
    root,
    plugins: [offlineShell()],
    logLevel: "error",
  });
  return join(root, "dist");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "web-updates-"));
  const original = await buildVersion(directory, "A");
  const updated = await buildVersion(directory, "B");
  let serving = original;
  let failAssets = false;
  const assetFailure = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html")
        return Response.redirect(new URL("/", request.url).href, 307);
      if (path === "/api/private") return Response.json({ private: true });
      if (failAssets && path.startsWith("/assets/")) {
        assetFailure.resolve();
        return new Response("Unavailable", { status: 503 });
      }
      const file = Bun.file(
        join(
          serving,
          path.startsWith("/assets/") || path === "/offline-worker.js"
            ? path
            : "index.html",
        ),
      );
      return (await file.exists())
        ? new Response(file, { headers: { "cache-control": "no-store" } })
        : new Response("Missing", { status: 404 });
    },
  });
  return {
    url: new URL("/root/jobs?tab=history#output", server.url).href,
    assetFailure: assetFailure.promise,
    deploy: (fail = false) => {
      serving = updated;
      failAssets = fail;
    },
    close: async () => {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function ready(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.locator("#version").waitFor();
}

async function checkForUpdate(page: Page, event: string) {
  await page.clock.fastForward(61_000);
  await page.evaluate((name) => {
    (name === "visibilitychange" ? document : window).dispatchEvent(
      new Event(name),
    );
  }, event);
}

async function confirmUpdate(page: Page) {
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.getByRole("button", { name: "Update and reload" }).click();
}

for (const engine of [chromium, firefox, webkit]) {
  const { CHROME_PATH } = process.env;
  const launchOptions =
    engine === chromium && CHROME_PATH ? { executablePath: CHROME_PATH } : {};
  it(`${engine.name()}: offers a saved update, protects other tabs, and reloads once`, async () => {
    const app = await fixture();
    const browser = await engine.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.clock.install();
      await ready(page, app.url);
      expect(
        await page.getByText("Update available", { exact: true }).count(),
      ).toBe(0);
      expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe(
        "1",
      );
      await page.evaluate(async () => {
        localStorage.setItem("pending-work", "keep me");
        await (await caches.open("unrelated-cache")).put(
          "/keep",
          new Response("keep"),
        );
        await fetch("/api/private");
      });
      app.deploy();
      await checkForUpdate(page, "visibilitychange");
      await page.getByText("Update available", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Draft" }).fill("Unsaved work");
      await page.getByRole("button", { name: "Update", exact: true }).click();
      await page.getByRole("button", { name: "Keep working" }).click();
      expect(
        await page.getByRole("textbox", { name: "Draft" }).inputValue(),
      ).toBe("Unsaved work");
      expect(await page.locator("#version").textContent()).toBe("A");
      // A worker already waiting when a new document registers must be noticed too.
      await page.reload();
      await page.getByText("Update available", { exact: true }).waitFor();
      const other = await context.newPage();
      await ready(other, app.url);
      await other
        .getByRole("textbox", { name: "Draft" })
        .fill("Other tab draft");
      await confirmUpdate(page);
      await page
        .getByText(
          "Save your work and close other Balebase tabs or windows, then try again.",
          { exact: true },
        )
        .waitFor();
      expect(
        await other.getByRole("textbox", { name: "Draft" }).inputValue(),
      ).toBe("Other tab draft");
      expect(await other.locator("#version").textContent()).toBe("A");
      await other.close();
      await confirmUpdate(page);
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "B",
      );
      expect(page.url()).toBe(app.url);
      expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe(
        "3",
      );
      expect(
        await page.evaluate(() => localStorage.getItem("pending-work")),
      ).toBe("keep me");
      expect(
        await page.evaluate(async () => Boolean(await caches.match("/keep"))),
      ).toBe(true);
      expect(
        await page.evaluate(async () =>
          Boolean(await caches.match("/api/private")),
        ),
      ).toBe(false);
      expect(
        await page.getByText("Update available", { exact: true }).count(),
      ).toBe(0);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "B",
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it(`${engine.name()}: failed downloads preserve the shell and reconnect retries`, async () => {
    const app = await fixture();
    const browser = await engine.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const update = ServiceWorkerRegistration.prototype.update;
        Reflect.set(window, "updateChecks", 0);
        ServiceWorkerRegistration.prototype.update = function () {
          Reflect.set(
            window,
            "updateChecks",
            Number(Reflect.get(window, "updateChecks")) + 1,
          );
          return update.call(this);
        };
      });
      await page.clock.install();
      await ready(page, app.url);
      app.deploy(true);
      await checkForUpdate(page, "focus");
      await app.assetFailure;
      await page.waitForFunction(
        async () =>
          !(await navigator.serviceWorker.getRegistration())?.installing,
      );
      expect(
        await page.getByText("Update available", { exact: true }).count(),
      ).toBe(0);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "A",
      );
      app.deploy();
      await context.setOffline(false);
      await checkForUpdate(page, "online");
      await page.getByText("Update available", { exact: true }).waitFor();
      const requests = await page.evaluate(() =>
        Reflect.get(window, "updateChecks"),
      );
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
      });
      expect(
        await page.evaluate(() => Reflect.get(window, "updateChecks")),
      ).toBe(requests);
      await context.setOffline(true);
      await confirmUpdate(page);
      await page
        .getByText("Reconnect to the internet, then try updating again.", {
          exact: true,
        })
        .waitFor();
      expect(await page.locator("#version").textContent()).toBe("A");
      await context.setOffline(false);
      await confirmUpdate(page);
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "B",
      );
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it(`${engine.name()}: updates survive an app crash and external activation waits for consent`, async () => {
    const app = await fixture();
    const browser = await engine.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.clock.install();
      const url = new URL(app.url);
      url.searchParams.set("broken", "true");
      await page.goto(url.href);
      await page
        .getByRole("heading", { name: "The app could not open" })
        .waitFor();
      await page.waitForFunction(() =>
        Boolean(navigator.serviceWorker.controller),
      );
      app.deploy();
      await checkForUpdate(page, "focus");
      await page.getByText("Update available", { exact: true }).waitFor();
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => resolve(),
            { once: true },
          );
          registration?.waiting?.postMessage({ type: "ACTIVATE_UPDATE" }, [
            new MessageChannel().port2,
          ]);
        });
      });
      expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe(
        "1",
      );
      expect(
        await page
          .getByRole("heading", { name: "The app could not open" })
          .count(),
      ).toBe(1);
      await confirmUpdate(page);
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "B",
      );
      expect(page.url()).toBe(url.href);
      expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe(
        "2",
      );
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it(`${engine.name()}: failed messages stay visible and a delayed activation still reloads once`, async () => {
    const app = await fixture();
    const browser = await engine.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.clock.install();
      await ready(page, app.url);
      app.deploy();
      await checkForUpdate(page, "focus");
      await page.getByText("Update available", { exact: true }).waitFor();
      await page.evaluate(() => {
        const original = ServiceWorker.prototype.postMessage;
        Reflect.set(window, "activationMode", "fail");
        ServiceWorker.prototype.postMessage = function (
          this: ServiceWorker,
          message: unknown,
          transfer: Transferable[] | StructuredSerializeOptions = [],
        ) {
          if ((message as { type?: string })?.type !== "ACTIVATE_UPDATE") {
            Reflect.apply(original, this, [message, transfer]);
            return;
          }
          const ports = Array.isArray(transfer)
            ? transfer
            : (transfer.transfer ?? []);
          if (Reflect.get(window, "activationMode") === "fail") {
            (ports[0] as MessagePort).postMessage("FAILED");
            return;
          }
          Reflect.set(window, "releaseActivation", () => {
            ServiceWorker.prototype.postMessage = original;
            Reflect.apply(original, this, [message, transfer]);
          });
        };
      });
      await confirmUpdate(page);
      const failure = page.getByText(
        "The update could not start. Please try again.",
        { exact: true },
      );
      await failure.waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect(await failure.count()).toBe(1);
      await page.evaluate(() => Reflect.set(window, "activationMode", "hold"));
      await confirmUpdate(page);
      await page.clock.fastForward(16_000);
      await page
        .getByText(
          "The update is taking longer than expected. This tab will reload when it is ready.",
          { exact: true },
        )
        .waitFor();
      await page.evaluate(() => Reflect.get(window, "releaseActivation")());
      await page.waitForFunction(
        () => document.querySelector("#version")?.textContent === "B",
      );
      expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe(
        "2",
      );
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);
}
