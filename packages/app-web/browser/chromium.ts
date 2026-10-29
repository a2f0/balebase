// Playwright's Chromium for the web shell's browser suites, or the Chrome at
// CHROME_PATH, as CI sets it. Closing has a measured budget, and a browser
// that overruns it is killed, so a loaded host can't fail a suite whose tests
// passed.

import { type Browser, chromium } from "playwright";

/**
 * The features Playwright 1.64 disables (its `chromiumSwitches`). Chrome reads
 * only the last `--disable-features`, so ours repeats them;
 * `chromium.test.ts` fails when Playwright's list changes.
 */
export const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

/**
 * Google Chrome 156 on macOS deletes its unexportable keys whenever an
 * off-the-record profile, which every Playwright context is, goes away: a
 * keychain query that took about 5 s each, one at a time, and Chrome won't
 * exit while one runs. These pages never make such keys. Playwright's own
 * Chromium closed in under 100 ms without the switch.
 */
export const DISABLED_FEATURES = [
  ...PLAYWRIGHT_DISABLED_FEATURES,
  "UnexportableKeyDeletion",
];

/**
 * How long closing the contexts and the browser may take before the browser
 * is killed. Closing took under 100 ms with the host's load average at 2-5,
 * and up to 5.8 s (Playwright's Chromium) and 3.5 s (Google Chrome) at 36-50.
 */
const CLOSE_TIMEOUT = 2_000;
/**
 * How long a killed browser may take to exit and have its profile removed,
 * which took under 30 ms at load 50. With the close budget, this keeps a
 * teardown hook within Bun's 5 s default.
 */
const KILL_TIMEOUT = 2_000;

const processes = new WeakMap<Browser, number>();

/**
 * Launches Chromium headless, or the Chrome at CHROME_PATH, and finds its
 * process, to kill if it won't close. If finding the process fails, closes
 * the browser within its close budget before rethrowing; a browser that
 * ignores even that is left to Playwright, which kills the browsers it
 * launched when the test process exits.
 */
export async function launchChromium(): Promise<Browser> {
  const { CHROME_PATH } = process.env;
  const browser = await chromium.launch({
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    args: [`--disable-features=${DISABLED_FEATURES.join(",")}`],
  });
  try {
    processes.set(browser, await browserProcess(browser));
  } catch (error) {
    await settles(browser.close(), CLOSE_TIMEOUT).catch(() => false);
    throw error;
  }
  return browser;
}

/** The browser process's id, which leads the process group of all its processes. */
export async function browserProcess(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((info) => info.type === "browser")?.id;
    if (!pid) throw new Error("Chromium didn't report its browser process");
    return pid;
  } finally {
    await session.detach();
  }
}

/**
 * Closes the contexts, then the browser, as Playwright advises. Past
 * `budget`, kills the browser's process group, waits for Playwright to see it
 * exit and remove its profile, and warns, since the tests have finished by
 * then. Fails only if the browser outlives the kill.
 */
export async function closeChromium(
  browser: Browser | undefined,
  budget = CLOSE_TIMEOUT,
): Promise<void> {
  if (!browser) return;
  const started = performance.now();
  const closing = (async () => {
    try {
      await Promise.all(browser.contexts().map((context) => context.close()));
    } finally {
      await browser.close();
    }
  })();
  if (await settles(closing, budget)) return;
  // Playwright's close resolves once the browser has exited and Playwright has
  // removed its profile, but only if it starts before the browser is gone, and
  // `closing` may still be waiting on a context. So one starts now, before the
  // kill; closing a context may then fail.
  const exited = Promise.allSettled([closing, browser.close()]);
  const pid = processes.get(browser);
  if (!pid) {
    throw new Error(
      `Chromium didn't close in ${budget} ms, and its process is unknown`,
    );
  }
  kill(pid);
  if (!(await settles(exited, KILL_TIMEOUT)) || running(pid)) {
    throw new Error(
      `Chromium (pid ${pid}) didn't exit within ${KILL_TIMEOUT} ms of being killed`,
    );
  }
  const elapsed = Math.round(performance.now() - started);
  console.warn(
    `Chromium (pid ${pid}) didn't close in ${budget} ms, so it was killed (${elapsed} ms)`,
  );
}

/** Whether `promise` resolves within `ms`; rethrows its rejection. */
async function settles(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills the browser's process group (Playwright starts the browser as its
 * leader), or the process alone.
 */
function kill(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has already exited.
    }
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
