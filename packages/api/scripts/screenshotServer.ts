/**
 * The API for screenshot capture (packages/app-web/playwright.screenshots.config.ts):
 * the seeded in-process API from screenshotApi.ts, listening on a fixed
 * port. Plaid stays faked while it serves.
 *
 * Run: bun run --cwd packages/api screenshots:api (CONTRIBUTING.md#screenshots).
 */
import { app } from "../src/app";
import { seededScreenshotApi } from "./screenshotApi";

const { SCREENSHOT_API_PORT, SCREENSHOT_APP_ORIGIN } = process.env;
const port = Number(SCREENSHOT_API_PORT ?? "34010");
const appOrigin = SCREENSHOT_APP_ORIGIN ?? "http://127.0.0.1:34020";
const apiOrigin = `http://127.0.0.1:${port}`;

const { bindings, executionContext } = await seededScreenshotApi({
  api: apiOrigin,
  app: appOrigin,
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Better Auth rate-limits by the client address Cloudflare would send.
  fetch: (incoming, server) => {
    const headers = new Headers(incoming.headers);
    headers.set("cf-connecting-ip", server.requestIP(incoming)?.address ?? "");
    return app.fetch(
      new Request(incoming, { headers }),
      bindings,
      executionContext,
    );
  },
});
console.log(`Screenshot API listening on ${apiOrigin} for ${appOrigin}`);
