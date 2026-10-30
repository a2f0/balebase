import { defineConfig, devices } from "playwright/test";

const apiPort = 34010;
const appPort = 34020;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const appBaseUrl = `http://127.0.0.1:${appPort}`;
// The seeded owner the capture signs in as; a placeholder, not a secret.
const owner = {
  email: "jordan@harborline.example",
  password: "screenshot capture password",
};

/**
 * Screenshot capture, kept apart from every test suite: `bun run screenshots`
 * from the repository root writes `.screenshots/<layout>/<theme>/<screen>.png`.
 * Both servers start here on fixed ports and never reuse a running one: the
 * API over an in-memory, freshly seeded database, and the web app pointed at
 * it. Nothing reaches staging, production, or `.secrets`.
 */
export default defineConfig({
  testDir: "./screenshots",
  testMatch: "**/*.capture.ts",
  // Failure traces go to the root's ignored test output, never `.screenshots`.
  outputDir: "../../.test_files/screenshots",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [["list"]],
  use: {
    baseURL: appBaseUrl,
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/New_York",
  },
  metadata: { apiBaseUrl, owner },
  projects: [
    {
      name: "web",
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    },
    {
      // The device profiles keep viewport, scale, and touch input; Chromium
      // keeps output independent of WebKit.
      name: "ipad",
      use: { ...devices["iPad Pro 11"], browserName: "chromium" },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command: "bun ../api/scripts/screenshotServer.ts",
      env: {
        SCREENSHOT_API_PORT: String(apiPort),
        SCREENSHOT_APP_ORIGIN: appBaseUrl,
        SCREENSHOT_EMAIL: owner.email,
        SCREENSHOT_PASSWORD: owner.password,
      },
      url: `${apiBaseUrl}/api/auth/ok`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      command: `bunx --bun --no-install vite --host 127.0.0.1 --port ${appPort} --strictPort`,
      env: { VITE_API_URL: apiBaseUrl },
      url: appBaseUrl,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
