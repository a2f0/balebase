/// <reference types="bun" />
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch, type Page } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";

// The gallery and home carousel, built against a fixture gallery of the
// shape `agent-tool screenshots build website` stages: a clean checkout has
// no capture, so the other browser tests only see the empty gallery.
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "website-gallery-"));
const dist = join(work, "dist");
const gallery = join(work, "gallery");
const types: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
// A 2x1 PNG stands in for every capture; the manifest records the real size.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII=",
  "base64",
);
const captures = [
  { project: "web", name: "projects", width: 2880, height: 1800 },
  { project: "web", name: "audit", width: 2880, height: 1800 },
  { project: "mobile", name: "projects", width: 1170, height: 2532 },
  { project: "mobile", name: "audit", width: 1170, height: 2532 },
];

function stageFixture() {
  const entries = captures.flatMap((capture) =>
    ["light", "dark"].map((theme) => {
      const path = `img/${capture.project}/${theme}/${capture.name}.png`;
      mkdirSync(join(gallery, `img/${capture.project}/${theme}`), {
        recursive: true,
      });
      writeFileSync(join(gallery, path), png);
      return { ...capture, theme, src: `/screenshot-gallery/${path}?v=0` };
    }),
  );
  const manifest = {
    schemaVersion: 1,
    projects: [
      { name: "web", label: "Desktop", frame: "none" },
      { name: "mobile", label: "Phone", frame: "phone" },
    ],
    themes: [
      { name: "light", label: "Light" },
      { name: "dark", label: "Dark" },
    ],
    screens: [
      { name: "projects", label: "Projects", alt: "The project list." },
      { name: "audit", label: "Audit", alt: "An audit in progress." },
    ],
    entries,
    capture: null,
  };
  writeFileSync(join(gallery, "manifest.json"), JSON.stringify(manifest));
}

let browser: Browser | undefined;

beforeAll(async () => {
  stageFixture();
  const build = Bun.spawn(
    ["bunx", "--bun", "--no-install", "astro", "build", "--outDir", dist],
    {
      cwd: siteRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SCREENSHOT_GALLERY_MANIFEST: join(gallery, "manifest.json"),
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Website build failed: ${stderr}`);
  browser = await launch(chromeLaunchOptions());
}, 120_000);

afterAll(async () => {
  await closeChrome(browser);
  rmSync(work, { recursive: true, force: true });
}, 120_000);

/** Serves the build, with the fixture as the staged gallery. */
async function openSite(width: number) {
  const page = await browser?.newPage();
  if (!page) throw new Error("Chrome did not start.");
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "light" },
  ]);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    const [root, path] = pathname.startsWith("/screenshot-gallery/")
      ? [gallery, pathname.slice("/screenshot-gallery".length)]
      : [dist, pathname.endsWith("/") ? `${pathname}index.html` : pathname];
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file)) {
      void request.respond({ status: 404, body: "" });
      return;
    }
    void request.respond({
      contentType: types[extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });
  return page;
}

/** The gallery's selection and its current screen's image. */
function current(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector(".shots-gallery");
    const image = document.querySelector<HTMLImageElement>(
      ".shots-slide[data-active] img.shots-image",
    );
    return {
      heading: document.querySelector("#page-title")?.textContent,
      image: image?.currentSrc.replace(location.origin, ""),
      loaded: (image?.naturalWidth ?? 0) > 0,
      project: root?.getAttribute("data-project"),
      theme: root?.getAttribute("data-shots-theme"),
      title: document.querySelector(".shots-title")?.textContent,
    };
  });
}

/** Waits until the current screen's image shows a capture in `theme`. */
function shown(page: Page, theme: string) {
  return page.waitForFunction(
    (wanted) => {
      const image = document.querySelector<HTMLImageElement>(
        ".shots-slide[data-active] img.shots-image",
      );
      return (
        (image?.naturalWidth ?? 0) > 0 &&
        image?.currentSrc.includes(`/${wanted}/`)
      );
    },
    {},
    theme,
  );
}

it("shows the first capture and switches themes", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/screenshots/");
    await page.waitForSelector(".shots-gallery[data-state='ready']");
    await shown(page, "light");
    expect(await current(page)).toMatchObject({
      image: "/screenshot-gallery/img/web/light/projects.png?v=0",
      loaded: true,
      project: "web",
      theme: "light",
      title: "Projects",
    });
    await page.click(".shots-icon-button[data-action='theme']");
    await shown(page, "dark");
    expect((await current(page)).image).toBe(
      "/screenshot-gallery/img/web/dark/projects.png?v=0",
    );
  } finally {
    await page.close();
  }
}, 30_000);

/** Text-to-background contrast of each selected element, as WCAG ratios. */
function contrasts(page: Page, selectors: string[]) {
  return page.evaluate((wanted) => {
    const channels = (color: string) =>
      (color.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = channels(color)
        .slice(0, 3)
        .map((value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    /** The nearest opaque-enough background behind `element`. */
    const background = (element: Element | null): string => {
      for (let node = element; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        const alpha = color.startsWith("rgba") ? channels(color)[3] : 1;
        if ((alpha ?? 0) >= 0.5) return color;
      }
      return "rgb(255, 255, 255)";
    };
    return Object.fromEntries(
      wanted.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return [selector, 0];
        const fore = luminance(getComputedStyle(element).color);
        const back = luminance(background(element));
        return [
          selector,
          (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05),
        ];
      }),
    );
  }, selectors);
}

it("keeps the gallery's text and controls readable in both themes", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/screenshots/");
    await page.waitForSelector(".shots-gallery[data-state='ready']");
    const text = [
      ".shots-title",
      ".shots-toggle-button[aria-pressed='true']",
      ".shots-toggle-button[aria-pressed='false']",
    ];
    for (const ratio of Object.values(await contrasts(page, text))) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    await page.click(".shots-icon-button[data-action='theme']");
    await shown(page, "dark");
    expect(await current(page)).toMatchObject({ theme: "dark" });
    for (const ratio of Object.values(await contrasts(page, text))) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    await page.click(".shots-slide[data-active] .shots-frame");
    await page.waitForSelector(".shots-lightbox[open] .shots-lightbox-close");
    expect(
      Object.values(await contrasts(page, [".shots-lightbox-close"]))[0],
    ).toBeGreaterThanOrEqual(3);
  } finally {
    await page.close();
  }
}, 30_000);

it("opens a deep link on its layout and screen, in a page that fits a phone", async () => {
  const page = await openSite(375);
  try {
    await page.goto("https://website.test/screenshots/mobile/audit/");
    expect(await page.title()).toBe("Audit, phone screenshot — Balebase");
    await page.waitForSelector(".shots-gallery[data-project='mobile']");
    await page.waitForFunction(
      () => document.querySelector(".shots-title")?.textContent === "Audit",
    );
    expect(await current(page)).toMatchObject({
      heading: "Audit, phone screenshot",
      project: "mobile",
    });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

it("rows the phone captures on the home page, linking to the gallery", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/");
    await page.waitForSelector(".shots-carousel");
    const links = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLAnchorElement>(
          ".shots-carousel-slide:not([aria-hidden='true']) a",
        ),
      ].map((link) => link.getAttribute("href")),
    );
    expect(links).toEqual([
      "/screenshots/mobile/projects/",
      "/screenshots/mobile/audit/",
    ]);
  } finally {
    await page.close();
  }
}, 30_000);
