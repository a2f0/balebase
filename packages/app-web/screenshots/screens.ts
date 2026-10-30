import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo } from "playwright/test";

export const themes = ["light", "dark"] as const;
export type Theme = (typeof themes)[number];

/** A captured page: its route, file stem, and text that proves it loaded. */
export interface Screen {
  name: string;
  route: string;
  ready: string;
}

/**
 * The main workspace pages, in the order a gallery shows them. Names are the
 * stable file stems below `.screenshots/<layout>/<theme>/`.
 */
export const screens: readonly Screen[] = [
  { name: "projects", route: "/projects", ready: "Riverside Clinic retrofit" },
  {
    name: "issues",
    route: "/issues",
    ready: "Replace corroded breaker in panel 2B",
  },
  { name: "audits", route: "/audits", ready: "NFPA 70E" },
  {
    name: "equipment",
    route: "/equipment",
    ready: "ThinkPad X1 Carbon Gen 13",
  },
  {
    name: "businesses",
    route: "/businesses",
    ready: "Harborline Electric LLC",
  },
  { name: "activity", route: "/activity", ready: "Warehouse 7 lighting" },
  {
    name: "organization",
    route: "/organization/people",
    ready: "Priya Natarajan",
  },
];

// index.html applies this key before first paint (packages/app/src/account/theme.ts).
const themeStorageKey = "balebase.theme";

const stillCss = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/** `.screenshots` at the repository root, three levels above this file. */
export const screenshotRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  ".screenshots",
);

/**
 * Removes this layout's earlier PNGs, leaving `.screenshots` itself (a link
 * to the shared store in most clones) and its `capture.json` alone.
 */
export async function clearLayout(layout: string) {
  for (const theme of themes) {
    const directory = path.join(screenshotRoot, layout, theme);
    const files = await readdir(directory).catch(() => []);
    for (const file of files)
      if (file.endsWith(".png")) await rm(path.join(directory, file));
  }
}

/** Signs the page's context in as the seeded owner, through the API. */
export async function signIn(page: Page, testInfo: TestInfo) {
  const { apiBaseUrl, owner } = testInfo.config.metadata as {
    apiBaseUrl: string;
    owner: { email: string; password: string };
  };
  const origin = new URL(testInfo.project.use.baseURL ?? "").origin;
  const response = await page.request.post(
    `${apiBaseUrl}/api/auth/sign-in/email`,
    { data: owner, headers: { origin } },
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** Pins the stored theme, reloads, and checks the page applied it. */
export async function pinTheme(page: Page, theme: Theme) {
  await page.goto("/projects");
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [themeStorageKey, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Opens a screen and waits until its seeded content has fully rendered. */
export async function openScreen(page: Page, screen: Screen) {
  await page.goto(screen.route);
  await page.addStyleTag({ content: stillCss });
  await expect(page.getByText(screen.ready).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[role="status"] .spinner')).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
  });
}
