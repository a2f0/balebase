import { existsSync } from "node:fs";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Puppeteer launch options for headless Chrome in a browser test. Without a
 * userDataDir, Puppeteer gives the browser a fresh profile and deletes it on
 * close. CHROME_PATH chooses the binary. Each package passes these to its own
 * puppeteer-core, because the repository root does not install it.
 */
export function chromeLaunchOptions({
  args = [] as string[],
  protocolTimeout = 10_000,
} = {}) {
  if (!existsSync(chrome))
    throw new Error(
      `Browser tests need Chrome, which is not at ${chrome}. Set CHROME_PATH.`,
    );
  return {
    executablePath: chrome,
    headless: true,
    pipe: true,
    timeout: 10_000,
    protocolTimeout,
    // Hosted Ubuntu runners restrict Chrome's sandbox. These browsers only
    // open generated fixtures in disposable profiles.
    args: [
      "--no-sandbox",
      "--password-store=basic",
      "--use-mock-keychain",
      ...args,
    ],
  };
}

/** What closeChrome uses of a Puppeteer browser. */
interface LaunchedChrome {
  close(): Promise<void>;
  process(): { pid?: number | undefined } | null;
}

/**
 * Ends a browser launched with chromeLaunchOptions. Puppeteer's close asks
 * Chrome to shut down and then waits for it without a limit: on a busy host
 * that took up to 8 s, past Bun's 5 s hook timeout. The profile is
 * disposable, so this kills Chrome's process group, as Puppeteer does when a
 * graceful close fails, and close then only waits for the exit and deletes
 * the profile.
 */
export async function closeChrome(browser: LaunchedChrome | undefined) {
  const pid = browser?.process()?.pid;
  if (pid) {
    try {
      // Puppeteer starts Chrome as the leader of its own process group.
      process.kill(-pid, "SIGKILL");
    } catch {
      // Chrome has already exited.
    }
  }
  await browser?.close();
}
