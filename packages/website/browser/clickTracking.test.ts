import { afterAll, beforeAll, expect, test } from "bun:test";
import { initClickTracking } from "@balebase/diagnostics/clickTracking";
import { type Browser, launch } from "puppeteer-core";
import { chromeLaunchOptions } from "../../../scripts/testing/chrome";

// The shared tracker runs here because diagnostics has no browser suite. The
// layout test and the web shell's suite check each bundle's own origins.
const app = "test-app";
const origins = {
  production: "https://tracked.example",
  staging: "https://staging.tracked.example",
};
const sources = new Map<boolean, string>();
let browser: Browser;

beforeAll(async () => {
  const entrypoint = Bun.resolveSync(
    "@balebase/diagnostics/clickTracking",
    import.meta.dir,
  );
  for (const production of [true, false]) {
    const build = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      define: { "import.meta.env.PROD": String(production) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const source = await build.outputs[0]?.text();
    if (!source) throw new Error("Tracking bundle is empty");
    sources.set(production, source);
  }
  browser = await launch(
    chromeLaunchOptions({
      args: [
        // Isolated contexts are incognito. Disable both automatic and incognito
        // HTTPS-first upgrades so HTTP rejection fixtures retain their origin.
        "--disable-features=HttpsUpgrades,HttpsFirstModeIncognito,HttpsFirstBalancedModeAutoEnable",
      ],
    }),
  );
}, 30_000);

// Chrome can take longer than Bun's 5 s hook default to exit on a loaded host.
afterAll(async () => {
  await browser?.close();
}, 30_000);

type Guard =
  | "none"
  | "dnt"
  | "gpc"
  | "extension"
  | "local"
  | "storage"
  | "webdriver";

async function fixture(
  origin: string,
  {
    guard = "none",
    production = true,
    named = false,
  }: { guard?: Guard; production?: boolean; named?: boolean } = {},
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
  const source = sources.get(production);
  if (!source) throw new Error("Missing tracker bundle");
  await page.evaluate(
    async (code, options) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const tracking = await import(url);
      URL.revokeObjectURL(url);
      const pages = new Set(["/", "/privacy"]);
      Reflect.set(
        window,
        "clickTracker",
        tracking.initClickTracking({
          app: options.app,
          origins: options.origins,
          ...(options.named && {
            page: () => {
              const path = location.pathname.replace(/\/$/, "") || "/";
              return pages.has(path) ? path : "/other";
            },
          }),
        }),
      );
    },
    source,
    { app, origins, named },
  );
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
  expect(initClickTracking({ app, origins })).toBeUndefined();
});

for (const [environment, origin] of Object.entries(origins)) {
  test(`attributes ${environment} clicks to the app and named page without private content`, async () => {
    const { page, batches, flush, close } = await fixture(origin, {
      named: true,
    });
    try {
      await page.evaluate(() =>
        history.replaceState(
          null,
          "",
          "/privacy/?token=private-token#private-fragment",
        ),
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
      expect(batch.environment).toBe(environment);
      expect(
        batch.events.map((event: Record<string, unknown>) => ({
          app: event.app,
          page: event.page,
          target: event.target,
          label: event.label,
        })),
      ).toEqual([
        { app, page: "/privacy", target: "button", label: null },
        { app, page: "/privacy", target: "p", label: null },
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

for (const guard of [
  "dnt",
  "gpc",
  "extension",
  "local",
  "storage",
  "webdriver",
] as const) {
  test(`honors ${guard} at initialization and delivery`, async () => {
    const { page, batches, flush, close } = await fixture(origins.production, {
      guard,
    });
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
  [origins.production, false],
  ["https://localhost", true],
  [`${origins.production}:8443`, true],
  [origins.production.replace("https:", "http:"), true],
  ["https://unregistered.example", true],
] as const) {
  test(`rejects ${host} with production=${production}`, async () => {
    const { page, batches, flush, close } = await fixture(host, {
      production,
    });
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

test("rechecks DNT and GPC before sending queued clicks", async () => {
  for (const flag of ["doNotTrack", "globalPrivacyControl"]) {
    const { page, batches, flush, close } = await fixture(origins.production);
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
}, 20_000);

test("without a page function, clicks use one generic page across every route", async () => {
  const { page, batches, flush, close } = await fixture(origins.production);
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
}, 20_000);
