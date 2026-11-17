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
import { deflateSync } from "node:zlib";
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
/** A blank grayscale PNG of the given size. */
function blankPng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(Bun.hash.crc32(body) >>> 0, body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; color type 0 is grayscale
  // Each row is a filter byte, then one byte per pixel, all zero.
  const pixels = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Small blank PNGs stand in for the captures, at the real captures' aspect
// ratios, so a loading image never moves the page; the manifest records the
// real sizes.
const desktop = { project: "web", width: 2880, height: 1800 };
const phone = { project: "mobile", width: 1170, height: 2532 };
const standIns: Record<string, Buffer> = {
  web: blankPng(288, 180),
  mobile: blankPng(195, 422),
};

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
// Every phone screen the real gallery captures, more than fit at once, so a
// row that shows several screens still has pages between its ends.
const longScreens = [
  "projects",
  "issues",
  "audits",
  "audit",
  "equipment",
  "businesses",
  "contracts",
  "contract",
  "finance",
  "library",
  "activity",
  "organization",
  "groups",
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
      const image = standIns[capture.project];
      if (!image) throw new Error(`No stand-in image for ${capture.project}.`);
      writeFileSync(join(gallery, path), image);
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
 * Opens the home page's phone row with reduced motion, so each step scrolls
 * at once instead of animating.
 */
async function showHomeRow(page: Page) {
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "light" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await page.goto("https://website.test/");
  await page.waitForSelector(".shots-carousel-step");
}

/**
 * Watches for a `scrollend` that finds the row moved from where watching
 * began; `ended` resolves then, or rejects if that has not happened after
 * 5 s.
 */
function watchRow(page: Page) {
  return page.evaluateHandle(() => {
    const track = document.querySelector(".shots-carousel-track");
    const from = track?.scrollLeft ?? 0;
    return {
      ended: new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(deadline);
          track?.removeEventListener("scrollend", finish);
        };
        // A scrollend that finds the row where watching began is left over
        // from an earlier scroll.
        const finish = () => {
          if (Math.abs((track?.scrollLeft ?? 0) - from) <= 1) return;
          stop();
          resolve();
        };
        const deadline = setTimeout(() => {
          stop();
          reject(new Error("The row did not finish scrolling within 5 s."));
        }, 5_000);
        track?.addEventListener("scrollend", finish);
      }),
    };
  });
}

/**
 * Each carousel slide's link, alt text, and whether anything hides it from
 * assistive technology, in order.
 */
function slideSummaries(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".shots-carousel-slide")].map((slide) => ({
      href: slide.querySelector("a")?.getAttribute("href"),
      alt: slide.querySelector("img")?.getAttribute("alt"),
      hidden: Boolean(
        slide.closest("[aria-hidden='true'], [inert]") ??
          slide.querySelector("[aria-hidden='true'], [inert]"),
      ),
    })),
  );
}

/**
 * Records the behavior each `scrollTo` call on the row takes effect with, in
 * either form: the behavior it asks for, or for `auto` and the positional
 * form, the row's CSS `scroll-behavior`.
 */
function recordScrollRequests(page: Page) {
  return page.evaluateHandle(() => {
    const track = document.querySelector<HTMLElement>(".shots-carousel-track");
    const behaviors: string[] = [];
    if (track) {
      const scrollTo = track.scrollTo;
      track.scrollTo = function (this: HTMLElement, ...args: unknown[]) {
        const [first] = args;
        const asked =
          first && typeof first === "object"
            ? (first as ScrollToOptions).behavior
            : undefined;
        const css = getComputedStyle(this).scrollBehavior;
        behaviors.push(
          asked && asked !== "auto"
            ? asked
            : css === "smooth"
              ? "smooth"
              : "instant",
        );
        return Reflect.apply(scrollTo, this, args);
      } as typeof track.scrollTo;
    }
    return { behaviors };
  });
}

/** Waits a few frames, long enough for a scroll that a press began to show. */
function frames(page: Page) {
  return page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise(requestAnimationFrame);
    }
  });
}

/**
 * Presses the focused step button, waits for the scroll it starts to end, and
 * reads the row.
 */
async function pressAndSettle(page: Page) {
  const watch = await watchRow(page);
  await page.keyboard.press("Enter");
  await page.evaluate((started) => started.ended, watch);
  return carouselSteps(page);
}

/**
 * Presses the focused step button where it should do nothing, and reads the
 * row a few frames later, when a scroll it began would show.
 */
async function pressInPlace(page: Page) {
  await page.keyboard.press("Enter");
  await frames(page);
  return carouselSteps(page);
}

/**
 * Scrolls the row straight to one end, as a swipe, trackpad, or arrow key
 * would, without its buttons. It sets the position rather than calling
 * `scrollTo`, so the requests the carousel makes stay its own.
 */
function scrollRow(page: Page, to: "start" | "end") {
  return page.evaluate((edge) => {
    const track = document.querySelector(".shots-carousel-track");
    if (track) track.scrollLeft = edge === "end" ? track.scrollWidth : 0;
  }, to);
}

it("rows the phone captures on the home page, linking to the gallery", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/");
    await page.waitForSelector(".shots-carousel");
    // Each screen appears once, in manifest order, with its alt text, and
    // none is hidden from assistive technology.
    expect(await slideSummaries(page)).toEqual([
      {
        href: "/screenshots/mobile/projects/",
        alt: "The project list.",
        hidden: false,
      },
      {
        href: "/screenshots/mobile/issues/",
        alt: "The open issues.",
        hidden: false,
      },
      {
        href: "/screenshots/mobile/audit/",
        alt: "An audit in progress.",
        hidden: false,
      },
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
    await page.setViewport({ width: 375, height: 900, hasTouch: true });
    await showHomeRow(page);
    const requests = await recordScrollRequests(page);
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
    expect(await pressInPlace(page)).toEqual({ ...start, focused: "-1" });

    // One screen fits at a time, so each press moves one screen. The first
    // is a real mouse click, which also focuses the button.
    const clicked = await watchRow(page);
    await page.click(nextStep);
    await page.evaluate((started) => started.ended, clicked);
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
    expect(await pressInPlace(page)).toEqual(end);

    await page.focus(previousStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}:not([aria-disabled])`);
    expect(await carouselSteps(page)).toEqual({ ...middle, focused: "-1" });

    // The last step back is a real tap.
    const tapped = await watchRow(page);
    await page.tap(previousStep);
    await page.evaluate((started) => started.ended, tapped);
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });

    // Scrolling the row to either end without its buttons, from one screen
    // short of it, updates the buttons as stepping does. Each step settles
    // first, so the scroll's watcher cannot take that step's scrollend.
    await page.focus(nextStep);
    expect(await pressAndSettle(page)).toMatchObject({ resting: 1 });
    let scrolled = await watchRow(page);
    await scrollRow(page, "end");
    await page.evaluate((started) => started.ended, scrolled);
    expect(await carouselSteps(page)).toMatchObject({
      previous: null,
      next: "true",
      scrollLeft: end.scrollLeft,
    });
    await page.focus(previousStep);
    expect(await pressAndSettle(page)).toMatchObject({ resting: 1 });
    scrolled = await watchRow(page);
    await scrollRow(page, "start");
    await page.evaluate((started) => started.ended, scrolled);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: null,
      scrollLeft: 0,
    });

    // With reduced motion, each of the six steps that moved the row scrolled
    // it instantly, and the presses at either end asked for no scroll.
    expect(
      await page.evaluate((recorded) => recorded.behaviors, requests),
    ).toEqual(Array.from({ length: 6 }, () => "instant"));
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

    // Narrowed and stepped to the end, then widened: the row returns to its
    // start, and both buttons become unavailable.
    await page.setViewport({ width: 700, height: 900 });
    await page.waitForSelector(`${nextStep}:not([aria-disabled])`);
    await page.focus(nextStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    const end = await carouselSteps(page);
    expect(end).toMatchObject({ previous: null, next: "true" });
    expect(end.scrollLeft).toBeGreaterThan(0);
    await page.setViewport({ width: 1440, height: 900 });
    await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toMatchObject({
      previous: "true",
      next: "true",
      scrollLeft: 0,
    });
  } finally {
    await page.close();
  }
}, 30_000);

// Where each press rests the long row: which screen sits where the first one
// starts (-1 at the end, which no screen reaches). Next runs from the start
// until it is unavailable, then Previous back; a page back from the end
// counts from the first screen fully in view.
const longRowPages = [
  {
    width: 700,
    fit: 2,
    next: [2, 4, 6, 8, 10, -1],
    previous: [9, 7, 5, 3, 1, 0],
  },
  { width: 1440, fit: 4, next: [4, 8, -1], previous: [5, 1, 0] },
];

for (const { width, fit, next, previous } of longRowPages) {
  it(`pages a long phone row ${fit} screens at a time at ${width}px, stopping at both ends`, async () => {
    const page = await openSite(width, longSite);
    try {
      await showHomeRow(page);
      expect(await carouselSteps(page)).toMatchObject({
        resting: 0,
        previous: "true",
        next: null,
      });
      // Overflowing, the row still shows each screen once, in order, with its
      // alt text, none hidden from assistive technology.
      expect(await slideSummaries(page)).toEqual(
        longScreens.map(({ name, alt }) => ({
          href: `/screenshots/mobile/${name}/`,
          alt,
          hidden: false,
        })),
      );

      // The keyboard reaches both buttons in order from the gallery link,
      // Previous included while it is unavailable.
      await page.focus(".shots-carousel-view-all");
      await page.keyboard.press("Tab");
      expect(await carouselSteps(page)).toMatchObject({ focused: "-1" });
      await page.keyboard.press("Tab");
      expect(await carouselSteps(page)).toMatchObject({ focused: "1" });

      // Only the last press reaches the end, where Next does nothing.
      const ahead = [];
      for (const _ of next) ahead.push(await pressAndSettle(page));
      expect(ahead.map((row) => row.resting)).toEqual(next);
      expect(ahead.map((row) => row.next)).toEqual(
        next.map((_, index) => (index === next.length - 1 ? "true" : null)),
      );
      const end = await carouselSteps(page);
      expect(ahead.at(-1)).toEqual(end);
      expect(end.scrollLeft).toBe(end.scrollEnd);
      expect(await pressInPlace(page)).toEqual(end);

      // Only the last press back reaches the start, where Previous does nothing.
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
      expect(await carouselSteps(page)).toMatchObject({ focused: "-1" });
      const behind = [];
      for (const _ of previous) behind.push(await pressAndSettle(page));
      expect(behind.map((row) => row.resting)).toEqual(previous);
      expect(behind.map((row) => row.previous)).toEqual(
        previous.map((_, index) =>
          index === previous.length - 1 ? "true" : null,
        ),
      );
      const start = await carouselSteps(page);
      expect(behind.at(-1)).toEqual(start);
      expect(start.scrollLeft).toBe(0);
      expect(await pressInPlace(page)).toEqual(start);
    } finally {
      await page.close();
    }
  }, 30_000);
}
