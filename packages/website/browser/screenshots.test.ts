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
 * Records the row's scroll positions until its next `scrollend`; `ended`
 * resolves with them, or rejects if the row is still scrolling after 5 s.
 */
function watchRow(page: Page) {
  return page.evaluateHandle(() => {
    const track = document.querySelector(".shots-carousel-track");
    const positions: number[] = [];
    const record = () => positions.push(Math.round(track?.scrollLeft ?? 0));
    track?.addEventListener("scroll", record);
    return {
      ended: new Promise<number[]>((resolve, reject) => {
        const stop = () => {
          clearTimeout(deadline);
          track?.removeEventListener("scroll", record);
          track?.removeEventListener("scrollend", finish);
        };
        const finish = () => {
          stop();
          resolve(positions);
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
 * Presses a step button and waits for the row's scroll to end, returning
 * each position the row passed through on the way.
 */
async function stepAndSettle(page: Page, selector: string) {
  const watch = await watchRow(page);
  await page.focus(selector);
  await page.keyboard.press("Enter");
  return page.evaluate((started) => started.ended, watch);
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
 * Waits for the row's images to load. The fixture's stand-in image is wider
 * than the size the manifest reserves, so each one that loads shortens the row
 * and moves its buttons, and a real click or tap aimed before then can miss.
 */
function rowImagesLoaded(page: Page) {
  return page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll<HTMLImageElement>(
          ".shots-carousel-slide img",
        ),
      ].every((image) => image.complete),
    { timeout: 5_000 },
  );
}

/**
 * Swipes the row toward one end with a touch gesture that Chrome runs
 * through its input pipeline, so a row that blocked touch scrolling fails.
 */
async function swipeRow(page: Page, toward: "start" | "end") {
  const track = await page.$(".shots-carousel-track");
  await track?.scrollIntoView();
  const box = await track?.boundingBox();
  if (!box) throw new Error("The phone row is not on the page.");
  const session = await page.createCDPSession();
  try {
    // A positive distance drags the content right, toward the start.
    await session.send("Input.synthesizeScrollGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      xDistance: toward === "end" ? -box.width : box.width,
      gestureSourceType: "touch",
    });
  } finally {
    await session.detach();
  }
}

it("rows the phone captures on the home page, linking to the gallery", async () => {
  const page = await openSite(1440);
  try {
    await page.goto("https://website.test/");
    await page.waitForSelector(".shots-carousel");
    // Each screen appears once, in manifest order, with its alt text, and
    // none is hidden from assistive technology.
    const slides = await page.evaluate(() =>
      [...document.querySelectorAll(".shots-carousel-slide")].map((slide) => ({
        href: slide.querySelector("a")?.getAttribute("href"),
        alt: slide.querySelector("img")?.getAttribute("alt"),
        hidden: Boolean(
          slide.closest("[aria-hidden='true'], [inert]") ??
            slide.querySelector("[aria-hidden='true'], [inert]"),
        ),
      })),
    );
    expect(slides).toEqual([
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

    // One screen fits at a time, so each press moves one screen. The first
    // is a real mouse click, which also focuses the button.
    await rowImagesLoaded(page);
    await page.click(nextStep);
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

    // The last step back is a real tap.
    await page.tap(previousStep);
    await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
    expect(await carouselSteps(page)).toEqual({ ...start, focused: "-1" });

    // Swiping to either end, from one screen short of it, updates the buttons
    // as stepping does. Each step settles first, so the swipe's watcher cannot
    // take that step's scrollend for its own.
    await page.focus(nextStep);
    expect(await pressAndSettle(page)).toMatchObject({ resting: 1 });
    let swipe = await watchRow(page);
    await swipeRow(page, "end");
    await page.evaluate((started) => started.ended, swipe);
    expect(await carouselSteps(page)).toMatchObject({
      previous: null,
      next: "true",
      scrollLeft: end.scrollLeft,
    });
    await page.focus(previousStep);
    expect(await pressAndSettle(page)).toMatchObject({ resting: 1 });
    swipe = await watchRow(page);
    await swipeRow(page, "start");
    await page.evaluate((started) => started.ended, swipe);
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

      // Only the last press reaches the end, where Next does nothing.
      await page.focus(nextStep);
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
      await page.focus(previousStep);
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

it("stops at the end when Next is pressed again while the row is moving", async () => {
  const page = await openSite(700);
  try {
    await showHomeRow(page, "no-preference");
    // Record every position, and press Next again from the first scroll that
    // finds the row between its ends, so the second press lands mid-motion.
    const run = await page.evaluateHandle((selector) => {
      const track = document.querySelector(".shots-carousel-track");
      const positions: number[] = [];
      let pressedAt: number | null = null;
      track?.addEventListener("scroll", () => {
        const left = track.scrollLeft;
        positions.push(Math.round(left));
        const end = track.scrollWidth - track.clientWidth;
        if (pressedAt === null && left > 1 && left < end - 1) {
          pressedAt = Math.round(left);
          document.querySelector<HTMLButtonElement>(selector)?.click();
        }
      });
      return { positions, pressedAt: () => pressedAt };
    }, nextStep);
    await page.focus(nextStep);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${nextStep}[aria-disabled='true']`);
    await frames(page);
    const { positions, pressedAt } = await page.evaluate(
      (recorded) => ({
        positions: recorded.positions,
        pressedAt: recorded.pressedAt(),
      }),
      run,
    );
    const end = await carouselSteps(page);
    expect(pressedAt).toBeGreaterThan(0);
    expect(pressedAt).toBeLessThan(end.scrollEnd);

    // The row moved only toward the end, stopped there, and kept focus.
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(end).toMatchObject({ previous: null, next: "true", focused: "1" });
    expect(end.scrollLeft).toBe(end.scrollEnd);
  } finally {
    await page.close();
  }
}, 30_000);

/**
 * Presses Next on the long row from its start, then presses it again from
 * the page while that first press animates: on the first scroll between half
 * a screen and one and a half screens along. Resolves settled once the second
 * scroll ends past where the first press was headed, missed when a skipped
 * frame carried the row past that window first, or timed out.
 */
async function pressNextMidScroll(page: Page) {
  const run = await page.evaluateHandle((selector) => {
    type Run =
      | { status: "waiting" }
      | { status: "pressed"; at: number }
      | { status: "settled"; at: number }
      | { status: "missed"; at: number }
      | { status: "timed out" };
    type RunEvent =
      | { type: "scroll"; left: number }
      | { type: "scrollend"; left: number }
      | { type: "deadline" };
    const track = document.querySelector(".shots-carousel-track");
    const [first, second] = document.querySelectorAll<HTMLElement>(
      ".shots-carousel-slide",
    );
    const pitch = (second?.offsetLeft ?? 0) - (first?.offsetLeft ?? 0);
    // The scroll position that rests the first screen at the start edge.
    const offset =
      (first?.offsetLeft ?? 0) -
      Number.parseFloat(track ? getComputedStyle(track).scrollPaddingLeft : "");
    // Two screens fit, so one press from the start heads two screens on.
    const firstDestination = offset + 2 * pitch;
    const transition = (run: Run, event: RunEvent): Run => {
      switch (run.status) {
        case "waiting": {
          if (event.type === "deadline") return { status: "timed out" };
          if (event.type !== "scroll") return run;
          const screens = (event.left - offset) / pitch;
          if (screens <= 0.5) return run;
          return screens < 1.5
            ? { status: "pressed", at: event.left }
            : { status: "missed", at: event.left };
        }
        case "pressed":
          if (event.type === "deadline") return { status: "timed out" };
          return event.type === "scrollend" && event.left > firstDestination + 1
            ? { status: "settled", at: run.at }
            : run;
        case "settled":
        case "missed":
        case "timed out":
          return run;
      }
    };
    let run: Run = { status: "waiting" };
    let finish = (_: Run) => {};
    const outcome = new Promise<Run>((resolve) => {
      finish = resolve;
    });
    const onScroll = () =>
      dispatch({ type: "scroll", left: track?.scrollLeft ?? 0 });
    const onScrollEnd = () =>
      dispatch({ type: "scrollend", left: track?.scrollLeft ?? 0 });
    const deadline = setTimeout(() => dispatch({ type: "deadline" }), 5_000);
    // Entering pressed presses Next; every other change ends the run and
    // removes both listeners and the timer.
    function dispatch(event: RunEvent) {
      const before = run;
      run = transition(run, event);
      if (run === before) return;
      if (run.status === "pressed") {
        document.querySelector<HTMLButtonElement>(selector)?.click();
        return;
      }
      clearTimeout(deadline);
      track?.removeEventListener("scroll", onScroll);
      track?.removeEventListener("scrollend", onScrollEnd);
      finish(run);
    }
    track?.addEventListener("scroll", onScroll);
    track?.addEventListener("scrollend", onScrollEnd);
    return { outcome };
  }, nextStep);
  await page.focus(nextStep);
  await page.keyboard.press("Enter");
  return page.evaluate((started) => started.outcome, run);
}

it("counts a Next press made mid-scroll from where the long row has reached", async () => {
  const page = await openSite(700, longSite);
  try {
    await showHomeRow(page, "no-preference");
    // When a skipped frame carries the row past the window, let the first
    // press finish, return to the start, and try again.
    let outcome = await pressNextMidScroll(page);
    for (let retry = 0; retry < 2 && outcome.status === "missed"; retry += 1) {
      await page.evaluate(async () => {
        const track = document.querySelector(".shots-carousel-track");
        let [last, still] = [-1, 0];
        while (still < 3) {
          await new Promise(requestAnimationFrame);
          const left = track?.scrollLeft ?? 0;
          [last, still] = [left, left === last ? still + 1 : 0];
        }
      });
      await page.evaluate(() =>
        document
          .querySelector(".shots-carousel-track")
          ?.scrollTo({ left: 0, behavior: "instant" }),
      );
      await page.waitForSelector(`${previousStep}[aria-disabled='true']`);
      outcome = await pressNextMidScroll(page);
    }
    expect(outcome.status).toBe("settled");

    // Pressed between half a screen and one and a half screens along, Next
    // counts from screen 1, so two screens on is screen 3. A dropped or
    // ignored press never moves past where the first press was headed
    // (screen 2), and paging from that pending destination rests on screen 4.
    expect(await carouselSteps(page)).toMatchObject({
      resting: 3,
      previous: null,
      next: null,
      focused: "1",
    });
  } finally {
    await page.close();
  }
}, 30_000);
