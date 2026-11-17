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

// The gallery and home carousel, built against fixture galleries of the
// shape `agent-tool screenshots build website` stages: a clean checkout has
// no capture, so the other browser tests only see the empty gallery.
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "website-gallery-"));
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
const desktop = { project: "web", width: 2880, height: 1800 };
const phone = { project: "mobile", width: 1170, height: 2532 };

/** A website build and the fixture gallery it serves. */
interface Site {
  dist: string;
  gallery: string;
  screens: { name: string; label: string; alt: string }[];
  captures: { project: string; name: string; width: number; height: number }[];
}

const screens = [
  { name: "projects", label: "Projects", alt: "The project list." },
  { name: "issues", label: "Issues", alt: "The open issues." },
  { name: "audit", label: "Audit", alt: "An audit in progress." },
];
const site: Site = {
  dist: join(work, "dist"),
  gallery: join(work, "gallery"),
  screens,
  captures: [desktop, phone].flatMap((layout) =>
    screens.map(({ name }) => ({ ...layout, name })),
  ),
};
// More phone captures than fit at once, like the real gallery's thirteen, so
// a row that shows several screens still has pages between its ends.
const longScreens = [
  "projects",
  "issues",
  "audits",
  "audit",
  "equipment",
  "contracts",
].map((name) => ({ name, label: name, alt: `The ${name} screen.` }));
const longSite: Site = {
  dist: join(work, "long-dist"),
  gallery: join(work, "long-gallery"),
  screens: longScreens,
  captures: longScreens.map(({ name }) => ({ ...phone, name })),
};

function stageFixture({ gallery, screens, captures }: Site) {
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
    ].filter(({ name }) => captures.some(({ project }) => project === name)),
    themes: [
      { name: "light", label: "Light" },
      { name: "dark", label: "Dark" },
    ],
    screens,
    entries,
    capture: null,
  };
  writeFileSync(join(gallery, "manifest.json"), JSON.stringify(manifest));
}

async function buildSite({ dist, gallery }: Site) {
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
}

let browser: Browser | undefined;

beforeAll(async () => {
  // One build at a time: both write the package's generated Astro files.
  for (const fixture of [site, longSite]) {
    stageFixture(fixture);
    await buildSite(fixture);
  }
  browser = await launch(chromeLaunchOptions());
}, 120_000);

afterAll(async () => {
  await closeChrome(browser);
  rmSync(work, { recursive: true, force: true });
}, 120_000);

/** Serves a build, with its fixture as the staged gallery. */
async function openSite(width: number, { dist, gallery }: Site = site) {
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

const previousStep = ".shots-carousel-step[data-step='-1']";
const nextStep = ".shots-carousel-step[data-step='1']";

/**
 * The home carousel's step buttons, how far its row has scrolled and can
 * scroll, and which slide rests where the first one starts: at the row's
 * scroll padding, within a pixel (-1 when none does, as at a mid-slide end).
 */
function carouselSteps(page: Page) {
  return page.evaluate(() => {
    const step = (delta: string) =>
      document.querySelector(`.shots-carousel-step[data-step='${delta}']`);
    const buttons = [step("-1"), step("1")];
    const track = document.querySelector(".shots-carousel-track");
    const inset =
      (track?.getBoundingClientRect().left ?? 0) +
      Number.parseFloat(track ? getComputedStyle(track).scrollPaddingLeft : "");
    return {
      resting: [
        ...document.querySelectorAll(".shots-carousel-slide"),
      ].findIndex(
        (slide) => Math.abs(slide.getBoundingClientRect().left - inset) <= 1,
      ),
      previous: buttons[0]?.getAttribute("aria-disabled") ?? null,
      next: buttons[1]?.getAttribute("aria-disabled") ?? null,
      focused: document.activeElement?.getAttribute("data-step") ?? null,
      opacity: buttons.map((button) =>
        button ? getComputedStyle(button).opacity : null,
      ),
      scrollLeft: Math.round(track?.scrollLeft ?? 0),
      scrollEnd: Math.round(track ? track.scrollWidth - track.clientWidth : 0),
    };
  });
}

/**
 * Opens the home page's phone row. Reduced motion, the default here, makes
 * each step scroll at once instead of animating.
 */
async function showHomeRow(
  page: Page,
  motion: "reduce" | "no-preference" = "reduce",
) {
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "light" },
    { name: "prefers-reduced-motion", value: motion },
  ]);
  await page.goto("https://website.test/");
  await page.waitForSelector(".shots-carousel-step");
}

/**
 * Presses a step button and waits for the row's scroll to end, returning
 * each position the row passed through on the way.
 */
async function stepAndSettle(page: Page, selector: string) {
  const scroll = await page.evaluateHandle(() => {
    const track = document.querySelector(".shots-carousel-track");
    const positions: number[] = [];
    const record = () => positions.push(Math.round(track?.scrollLeft ?? 0));
    track?.addEventListener("scroll", record);
    return {
      ended: new Promise<number[]>((resolve) =>
        track?.addEventListener(
          "scrollend",
          () => {
            track.removeEventListener("scroll", record);
            resolve(positions);
          },
          { once: true },
        ),
      ),
    };
  });
  await page.focus(selector);
  await page.keyboard.press("Enter");
  return page.evaluate((started) => started.ended, scroll);
}

/** Waits a few frames, long enough for a scroll that a press began to show. */
function frames(page: Page) {
  return page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise(requestAnimationFrame);
    }
  });
}

/** Scrolls the row directly, as a swipe or trackpad would. */
function scrollRow(page: Page, to: "start" | "end") {
  return page.evaluate((edge) => {
    const track = document.querySelector(".shots-carousel-track");
    track?.scrollTo({
      left: edge === "end" ? track.scrollWidth : 0,
      behavior: "instant",
    });
  }, to);
}

it("rows the phone captures on the home page, linking to the gallery", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/");
    await page.waitForSelector(".shots-carousel");
    // Each screen appears once, in manifest order.
    const links = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLAnchorElement>(
          ".shots-carousel-slide a",
        ),
      ].map((link) => link.getAttribute("href")),
    );
    expect(links).toEqual([
      "/screenshots/mobile/projects/",
      "/screenshots/mobile/issues/",
      "/screenshots/mobile/audit/",
    ]);
    // Every capture fits this wide, so neither step button has anywhere to go.
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: "true",
    });
    // The carousel renders the page's one link to the full gallery.
    const viewAll = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("#main a")]
        .filter((link) => link.textContent?.trim() === "See every screen")
        .map((link) => ({
          href: link.getAttribute("href"),
          inControls: link.matches(
            ".shots-carousel-controls > .shots-carousel-view-all",
          ),
        })),
    );
    expect(viewAll).toEqual([{ href: "/screenshots/", inControls: true }]);
    expect(
      Object.values(await contrasts(page, [".shots-carousel-view-all"]))[0],
    ).toBeGreaterThanOrEqual(4.5);
    await Promise.all([
      page.waitForNavigation(),
      page.click(".shots-carousel-view-all"),
    ]);
    expect(new URL(page.url()).pathname).toBe("/screenshots/");
  } finally {
    await page.close();
  }
}, 30_000);

it("stops the home page's phone row at both ends on a phone", async () => {
  const page = await openSite(375);
  try {
    await showHomeRow(page);
    // An unavailable button stays visible, only dimmed, since it can hold focus.
    const start = await carouselSteps(page);
    expect(start).toMatchObject({
      resting: 0,
      previous: "true",
      next: null,
      opacity: ["0.4", "1"],
      scrollLeft: 0,
    });

    // Previous at the start leaves the row in place and keeps focus.
    await page.focus(previousStep);
    await page.keyboard.press("Enter");
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });

    // One screen fits at a time, so each press moves one screen.
    await page.focus(nextStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${previousStep}:not([aria-disabled])`);
    const middle = await carouselSteps(page);
    expect(middle).toMatchObject({
      resting: 1,
      previous: null,
      next: null,
      focused: "1",
      opacity: ["1", "1"],
    });

    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    // The last screen cannot rest where the first one starts, so the row
    // stops mid-slide, at the limit of its scroll.
    const end = await carouselSteps(page);
    expect(end).toMatchObject({
      resting: -1,
      previous: null,
      next: "true",
      focused: "1",
      opacity: ["1", "0.4"],
    });
    expect(end.scrollLeft).toBeGreaterThan(middle.scrollLeft);
    expect(end.scrollLeft).toBe(end.scrollEnd);

    // Next at the end leaves the row in place and keeps focus.
    await page.keyboard.press("Enter");
    expect(await carouselSteps(page)).toEqual(end);

    await page.focus(previousStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}:not([aria-disabled])`);
    expect(await carouselSteps(page)).toEqual({ ...middle, focused: "-1" });

    await page.keyboard.press("Enter");
    await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });

    // Swiping to either end updates the buttons as stepping does.
    await scrollRow(page, "end");
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toMatchObject({
      previous: null,
      next: "true",
      scrollLeft: end.scrollLeft,
    });
    await scrollRow(page, "start");
    await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: null,
      scrollLeft: 0,
    });
  } finally {
    await page.close();
  }
}, 30_000);

it("updates the phone row's buttons when the page resizes", async () => {
  const page = await openSite(1440);
  try {
    await showHomeRow(page);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: "true",
    });
    // Narrowed without scrolling, the row overflows: only Next can move.
    await page.setViewport({ width: 700, height: 900 });
    await page.waitForSelector(`${nextStep}:not([aria-disabled])`);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: null,
      scrollLeft: 0,
    });
    // Widened again, every screen fits and neither button can move.
    await page.setViewport({ width: 1440, height: 900 });
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: "true",
      scrollLeft: 0,
    });
  } finally {
    await page.close();
  }
}, 30_000);

it("pages a long phone row by the screens that fit, stopping at both ends", async () => {
  // Two of the six screens fit at a time.
  const page = await openSite(700, longSite);
  try {
    await showHomeRow(page);
    expect(await carouselSteps(page)).toMatchObject({
      resting: 0,
      previous: "true",
      next: null,
    });

    // Each press moves past both screens in view.
    await page.focus(nextStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${previousStep}:not([aria-disabled])`);
    const second = await carouselSteps(page);
    expect(second).toMatchObject({ resting: 2, previous: null, next: null });

    // A full page more would start past the end, so the row stops at its
    // scroll limit, and Next then does nothing.
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    const end = await carouselSteps(page);
    expect(end).toMatchObject({ resting: -1, previous: null, next: "true" });
    expect(end.scrollLeft).toBe(end.scrollEnd);
    await page.keyboard.press("Enter");
    expect(await carouselSteps(page)).toEqual(end);

    // Back from the end, a page counts from the first screen fully in view.
    await page.focus(previousStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}:not([aria-disabled])`);
    expect(await carouselSteps(page)).toEqual({ ...second, focused: "-1" });

    await page.keyboard.press("Enter");
    await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toMatchObject({
      resting: 0,
      next: null,
      scrollLeft: 0,
    });
  } finally {
    await page.close();
  }
}, 30_000);

it("stops the phone row at each end when steps animate", async () => {
  const page = await openSite(700);
  try {
    await showHomeRow(page, "no-preference");
    const start = await carouselSteps(page);
    expect(start).toMatchObject({
      previous: "true",
      next: null,
      scrollLeft: 0,
    });

    const forward = await stepAndSettle(page, nextStep);
    const end = await carouselSteps(page);
    expect(end).toMatchObject({ previous: null, next: "true", focused: "1" });
    expect(end.scrollLeft).toBe(end.scrollEnd);
    // The row animated there, passing positions between its two ends.
    const between = (left: number) => left > 0 && left < end.scrollLeft;
    expect(forward.filter(between)).not.toHaveLength(0);
    await page.keyboard.press("Enter");
    await frames(page);
    expect(await carouselSteps(page)).toEqual(end);

    const back = await stepAndSettle(page, previousStep);
    expect(back.filter(between)).not.toHaveLength(0);
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });
    await page.keyboard.press("Enter");
    await frames(page);
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });
  } finally {
    await page.close();
  }
}, 30_000);
