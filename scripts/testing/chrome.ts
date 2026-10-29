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
