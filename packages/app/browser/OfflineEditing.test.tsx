import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, launch, type Page } from "puppeteer-core";
import { build } from "vite";
import type {} from "./offlineAppFixture";

async function withOfflineBrowser(
  run: (page: Page, browser: Browser, directory: string) => Promise<void>,
  api: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ error: "Not available" }, { status: 503 }),
) {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for offline editing tests.");
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
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: join(directory, "profile"),
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean(window.offlineTest));
    await run(page, browser, directory);
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function press(page: Page, label: string) {
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

async function openDraft(page: Page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.endsWith("· Draft"),
      ),
    { polling: 100 },
  );
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.endsWith("· Draft"))
      ?.click(),
  );
  await page.waitForSelector("select");
}

it("completes the latest saved answers without overwriting another tab's edit", async () => {
  await withOfflineBrowser(async (page, browser) => {
    const id = await page.evaluate(() => window.offlineTest.seed());
    await page.evaluate(async (auditId) => {
      await window.offlineTest.answer(auditId, "pass");
      window.offlineTest.mount();
    }, id);
    await openDraft(page);
    expect(await page.$eval("select", (field) => field.value)).toBe("pass");
    const other = await browser.newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => Boolean(window.offlineTest));
    await other.evaluate(
      (auditId) => window.offlineTest.answer(auditId, "fail"),
      id,
    );
    await page.bringToFront();
    await press(page, "Complete and queue audit");
    await page.waitForFunction(
      async () => (await window.offlineTest.read())?.audits[0]?.queued,
      { polling: 100 },
    );
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.audits[0]?.responses).toEqual({ check: "fail" });
    const operation = saved?.jobs.find((job) => job.id === id)?.operation;
    expect(operation?.type).toBe("audit");
    if (operation?.type === "audit")
      expect(operation.responses).toEqual({ check: "fail" });
    expect(await page.$eval("select", (field) => field.value)).toBe("fail");
  });
}, 30_000);

for (const path of ["/offline", "/"]) {
  it(`keeps an unsaved issue and photo through App revalidation after reopening ${path} offline`, async () => {
    const user = {
      id: "user-1",
      name: "Inspector",
      email: "inspector@example.com",
      emailVerified: true,
    };
    let releaseAccess: (() => void) | undefined;
    const access = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    await withOfflineBrowser(
      async (page, _browser, directory) => {
        await page.evaluate(() => window.offlineTest.seed());
        await page.setOfflineMode(true);
        await page.evaluate((pathname) => {
          history.replaceState(null, "", pathname);
          window.offlineAppTest.mount();
        }, path);
        await openDraft(page);
        await press(page, "Raise issue");
        const title = 'form[aria-label="Issue details"] input';
        const description = 'form[aria-label="Issue details"] textarea';
        await page.type(title, "Damaged railing");
        await page.type(description, "Repair before reopening the staircase.");
        const photo = join(directory, "rail.png");
        await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
        await (await page.$('input[type="file"]'))?.uploadFile(photo);
        const request = page.waitForRequest(
          (entry) =>
            new URL(entry.url()).pathname === "/api/organization-groups/access",
        );
        await page.setOfflineMode(false);
        await page.evaluate(() => window.offlineAppTest.refreshSession());
        await request;
        // Session has returned, but organization access is deliberately unresolved.
        expect(await page.$eval(title, (field) => field.value)).toBe(
          "Damaged railing",
        );
        expect(await page.$eval(description, (field) => field.value)).toBe(
          "Repair before reopening the staircase.",
        );
        expect(
          await page.$eval(
            'input[type="file"]',
            (field) => (field as HTMLInputElement).files?.[0]?.name,
          ),
        ).toBe("rail.png");
        releaseAccess?.();
        await page.waitForFunction(
          () => !document.body.textContent?.includes("Local work only"),
          { polling: 100 },
        );
        expect(new URL(page.url()).pathname).toBe("/offline");
        expect(await page.$eval(title, (field) => field.value)).toBe(
          "Damaged railing",
        );
        await press(page, "Save issue on device");
        await page.waitForFunction(
          async () => (await window.offlineTest.read())?.issues.length === 1,
          { polling: 100 },
        );
        const issue = (await page.evaluate(() => window.offlineTest.read()))
          ?.issues[0];
        expect(issue?.operation.title).toBe("Damaged railing");
        expect(issue?.operation.description).toBe(
          "Repair before reopening the staircase.",
        );
        const image = issue?.images[0];
        if (!image) throw new Error("Selected photo was lost");
        expect(
          await page.evaluate((id) => window.offlineTest.photo(id), image.id),
        ).toEqual({ type: "image/png", bytes: [1, 2, 3, 4] });
      },
      async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/auth/get-session")
          return Response.json({
            user,
            session: {
              id: "session",
              token: "fixture",
              userId: user.id,
              activeOrganizationId: "org-1",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          });
        if (pathname === "/api/organization-settings/organizations")
          return Response.json({
            organizations: [{ id: "org-1", name: "Test team" }],
          });
        if (pathname === "/api/organization-groups/access") {
          await access;
          return Response.json({
            capabilities: [],
            memberRole: "owner",
            ownerCount: 1,
          });
        }
        if (pathname === "/api/offline/forms")
          return Response.json({ templates: [], members: [user] });
        return Response.json([]);
      },
    ).finally(() => releaseAccess?.());
  }, 30_000);
}
