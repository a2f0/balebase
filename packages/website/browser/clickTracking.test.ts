import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import { initClickTracking as initApp } from "../../app-web/src/clickTracking";
import { initClickTracking as initWebsite } from "../src/clickTracking";

const profile = mkdtempSync(join(tmpdir(), "balebase-clicks-"));
const sources = new Map<string, string>();
let browser: Browser;
const targets = [
  { app: "website", origin: "https://balebase.com", environment: "production" },
  {
    app: "website",
    origin: "https://website-staging.balebase.com",
    environment: "staging",
  },
  {
    app: "web-app",
    origin: "https://app.balebase.com",
    environment: "production",
  },
  {
    app: "web-app",
    origin: "https://app-staging.balebase.com",
    environment: "staging",
  },
];

beforeAll(async () => {
  for (const [app, module] of [
    ["website", "../src/clickTracking.ts"],
    ["web-app", "../../app-web/src/clickTracking.ts"],
  ] as const) {
    for (const production of [true, false]) {
      const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL(module, import.meta.url))],
        target: "browser",
        define: { "import.meta.env.PROD": String(production) },
      });
      if (!build.success) throw new Error(build.logs.join("\n"));
      const source = await build.outputs[0]?.text();
      if (!source) throw new Error("Tracking bundle is empty");
      sources.set(`${app}:${production}`, source);
    }
  }
  browser = await launch({
    executablePath:
      process.env.CHROME_PATH ||
      Bun.which("google-chrome") ||
      Bun.which("chromium") ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    pipe: true,
    userDataDir: profile,
    args: [
      "--no-sandbox",
      "--password-store=basic",
      "--use-mock-keychain",
      // Keep HTTP-origin rejection tests on HTTP instead of Chrome's upgrade.
      "--disable-features=HttpsUpgrades",
    ],
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  rmSync(profile, { recursive: true, force: true });
});

type Guard =
  | "none"
  | "dnt"
  | "gpc"
  | "extension"
  | "local"
  | "storage"
  | "webdriver";

async function fixture(
  app: string,
  origin: string,
  guard: Guard = "none",
  production = true,
) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const batches: string[] = [];
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (request.url() === "https://ct.a2f0.net/v1/clicks") {
      batches.push((await request.fetchPostData()) ?? "");
      await request.respond({
        status: 202,
        headers: { "Access-Control-Allow-Origin": origin },
      });
    } else {
      await request.respond({
        contentType: "text/html",
        body: `<!doctype html>
        <button id="action">Private user text</button><input value="private-value">
        <div contenteditable="true">private-edit</div>
        <div data-ct-ignore><button id="ignored">ignored</button></div>
        <p id="plain">Private paragraph</p>`,
      });
    }
  });
  await page.evaluateOnNewDocument((mode) => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => mode === "webdriver",
    });
    Object.defineProperty(navigator, "doNotTrack", {
      get: () => (mode === "dnt" ? "1" : null),
      configurable: true,
    });
    Object.defineProperty(navigator, "globalPrivacyControl", {
      get: () => mode === "gpc",
      configurable: true,
    });
    if (mode === "local") localStorage.setItem("ct:opt-out", "1");
    if (mode === "storage")
      Object.defineProperty(window, "localStorage", {
        get: () => {
          throw new Error("blocked");
        },
      });
  }, guard);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  expect(await page.evaluate(() => location.origin)).toBe(origin);
  if (guard === "extension")
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-ct-disabled", ""),
    );
  const source = sources.get(`${app}:${production}`);
  if (!source) throw new Error("Missing tracker bundle");
  await page.evaluate(async (code) => {
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" }),
    );
    const { initClickTracking } = await import(url);
    URL.revokeObjectURL(url);
    Reflect.set(window, "clickTracker", initClickTracking());
  }, source);
  const flush = async () => {
    await page.evaluate(async () => {
      await (
        Reflect.get(window, "clickTracker") as
          | { flush(): Promise<void> }
          | undefined
      )?.flush();
    });
  };
  return { batches, page, flush, close: () => context.close() };
}

test("server imports never initialize a tracker", () => {
  expect(initApp()).toBeUndefined();
  expect(initWebsite()).toBeUndefined();
});

for (const target of targets) {
  test(`${target.app} attributes ${target.environment} clicks without private content`, async () => {
    const { page, batches, flush, close } = await fixture(
      target.app,
      target.origin,
    );
    try {
      await page.evaluate(
        (app) =>
          history.replaceState(
            null,
            "",
            app === "website"
              ? "/privacy/?token=private-token#private-fragment"
              : "/finance/accounts/private-account?token=private-token#private-fragment",
          ),
        target.app,
      );
      await page.click("input");
      await page.click("[contenteditable]");
      await page.click("#ignored");
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>("#action")?.click(),
      );
      await flush();
      expect(batches).toHaveLength(0);
      await page.click("#action");
      await page.click("#plain");
      await flush();
      expect(batches).toHaveLength(1);
      const batch = JSON.parse(batches[0] ?? "");
      expect(batch.site).toBe("balebase");
      expect(batch.environment).toBe(target.environment);
      expect(
        batch.events.map((event: Record<string, unknown>) => ({
          app: event.app,
          page: event.page,
          target: event.target,
          label: event.label,
        })),
      ).toEqual([
        {
          app: target.app,
          page: target.app === "website" ? "/privacy" : "/",
          target: "button",
          label: null,
        },
        {
          app: target.app,
          page: target.app === "website" ? "/privacy" : "/",
          target: "p",
          label: null,
        },
      ]);
      expect(batches.join("")).not.toMatch(/private|action|ignored/i);
      await page.evaluate(async () => {
        (Reflect.get(window, "clickTracker") as { destroy(): void }).destroy();
      });
      await page.click("#action");
      await flush();
      expect(batches).toHaveLength(1);
    } finally {
      await close();
    }
  });
}

for (const app of ["website", "web-app"]) {
  const origin =
    app === "website" ? "https://balebase.com" : "https://app.balebase.com";
  for (const guard of [
    "dnt",
    "gpc",
    "extension",
    "local",
    "storage",
    "webdriver",
  ] as const) {
    test(`${app} honors ${guard} at initialization and delivery`, async () => {
      const { page, batches, flush, close } = await fixture(app, origin, guard);
      try {
        await page.click("#action");
        await flush();
        expect(batches).toHaveLength(0);
      } finally {
        await close();
      }
    });
  }
  for (const [host, production] of [
    [origin, false],
    ["https://localhost", true],
    [`${origin}:8443`, true],
    [origin.replace("https:", "http:"), true],
    ["https://unregistered.example", true],
  ] as const) {
    test(`${app} rejects ${host} with production=${production}`, async () => {
      const { page, batches, flush, close } = await fixture(
        app,
        host,
        "none",
        production,
      );
      try {
        expect(
          await page.evaluate(
            () => Reflect.get(window, "clickTracker") === undefined,
          ),
        ).toBe(true);
        await page.click("#action");
        await flush();
        expect(batches).toHaveLength(0);
      } finally {
        await close();
      }
    });
  }
  test(`${app} rechecks DNT and GPC before sending queued clicks`, async () => {
    for (const flag of ["doNotTrack", "globalPrivacyControl"]) {
      const { page, batches, flush, close } = await fixture(app, origin);
      try {
        await page.click("#action");
        await page.evaluate(
          (name) =>
            Object.defineProperty(navigator, name, {
              get: () => (name === "doNotTrack" ? "1" : true),
            }),
          flag,
        );
        await flush();
        expect(batches).toHaveLength(0);
      } finally {
        await close();
      }
    }
  });
}

test("app clicks use one generic page across every workspace route", async () => {
  const { page, batches, flush, close } = await fixture(
    "web-app",
    "https://app.balebase.com",
  );
  try {
    const routes = [
      "/organization/people/private-person",
      "/contracts/templates/private-template",
      "/sign/private-token",
      "/me/screening/private-screening",
      "/root/users",
      "/finance/accounts/private-account",
      "/unknown/private-user",
      "/account/security",
    ];
    for (const route of routes) {
      await page.evaluate(
        (path) => history.replaceState(null, "", path),
        route,
      );
      await page.click("#action");
    }
    await flush();
    expect(
      JSON.parse(batches[0] ?? "").events.map(
        (event: { page: string }) => event.page,
      ),
    ).toEqual(routes.map(() => "/"));
    expect(batches.join("")).not.toContain("private");
  } finally {
    await close();
  }
});
