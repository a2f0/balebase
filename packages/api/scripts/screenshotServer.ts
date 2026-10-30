/**
 * The API for screenshot capture (packages/app-web/playwright.screenshots.config.ts):
 * the real Worker app over an in-memory database with every migration
 * applied, seeded with one deterministic organization before it listens.
 * Nothing leaves the process: email is discarded, storage is a map, and the
 * auth secret is a fixed placeholder, so no `.secrets` are read.
 *
 * Seeding runs on a fixed clock that advances a minute per request, so every
 * capture shows the same timestamps in the same order; the clock is real
 * again before the browser signs in, so its session cookie stays current.
 *
 * Run: SCREENSHOT_API_PORT=34010 SCREENSHOT_APP_ORIGIN=http://127.0.0.1:34020 \
 *   bun scripts/screenshotServer.ts
 */
import { setSystemTime } from "bun:test";
import { app } from "../src/app";
import { memoryStorage, testBindings } from "../src/testing/bindings";
import { toD1 } from "../src/testing/d1";
import { createTestDatabase } from "../src/testing/database";
import { seedScreenshotData } from "./screenshotSeed";

const { SCREENSHOT_API_PORT, SCREENSHOT_APP_ORIGIN } = process.env;
const port = Number(SCREENSHOT_API_PORT ?? "34010");
const appOrigin = SCREENSHOT_APP_ORIGIN ?? "http://127.0.0.1:34020";
const apiOrigin = `http://127.0.0.1:${port}`;

const database = createTestDatabase();
// Seeding waits for each request's background work before the next one.
let pending: Promise<unknown>[] | undefined = [];
const executionContext = {
  passThroughOnException: () => undefined,
  props: {},
  waitUntil: (promise: Promise<unknown>) => {
    const settled = promise.catch((error: unknown) =>
      console.error("Screenshot API background work failed:", error),
    );
    pending?.push(settled);
  },
} as unknown as ExecutionContext;
const bindings = testBindings({
  BETTER_AUTH_SECRET: "screenshot-capture-placeholder-secret",
  BETTER_AUTH_URL: apiOrigin,
  CORS_ORIGIN: appOrigin,
  DB: toD1(database),
  STORAGE: memoryStorage().bucket,
});

const seededFrom = Date.parse("2026-10-26T13:00:00.000Z");
let seededRequests = 0;

const request = async (path: string, init: RequestInit = {}) => {
  setSystemTime(new Date(seededFrom + seededRequests++ * 60_000));
  const headers = new Headers(init.headers);
  headers.set("origin", appOrigin);
  headers.set("cf-connecting-ip", "127.0.0.1");
  const response = await app.fetch(
    new Request(`${apiOrigin}${path}`, { ...init, headers }),
    bindings,
    executionContext,
  );
  await Promise.all(pending?.splice(0) ?? []);
  return response;
};

await seedScreenshotData({ database, request });
setSystemTime();
pending = undefined;

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
