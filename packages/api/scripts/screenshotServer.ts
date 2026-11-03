/**
 * The API for screenshot capture (packages/app-web/playwright.screenshots.config.ts):
 * the real Worker app over an in-memory database with every migration
 * applied, seeded from the continuity genesis before it listens. Nothing
 * leaves the process: email lands in an in-memory outbox, storage is a map,
 * images keep their bytes, Plaid is a fake answering with the continuity
 * bank feed, and the auth secret is a fixed placeholder, so no `.secrets` are
 * read.
 *
 * Seeding runs on a fixed clock: each step starts at noon in Merrow Bay on
 * the canon day it happened, and the clock advances a minute per request, so
 * every capture shows the same timestamps in the same order. The clock is
 * real again before the browser signs in, so its session cookie stays
 * current.
 *
 * Run: bun run --cwd packages/api screenshots:api (CONTRIBUTING.md#screenshots).
 */
import { setSystemTime } from "bun:test";
import { app } from "../src/app";
import { memoryStorage, testBindings } from "../src/testing/bindings";
import { toD1 } from "../src/testing/d1";
import { createTestDatabase } from "../src/testing/database";
import type { Bindings } from "../src/types";
import { screenshotProPrice, seedScreenshotData } from "./screenshotSeed";
import {
  emailOutbox,
  fakePlaid,
  inlineSyncQueue,
  passThroughImages,
  plaidBindings,
} from "./screenshotServices";

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
const outbox = emailOutbox();
const bindings: Bindings = testBindings({
  ...plaidBindings,
  BETTER_AUTH_SECRET: "screenshot-capture-placeholder-secret",
  BETTER_AUTH_URL: apiOrigin,
  CORS_ORIGIN: appOrigin,
  DB: toD1(database),
  EMAIL: outbox.binding,
  FINANCE_SYNC_QUEUE: inlineSyncQueue(() => bindings),
  IMAGES: passThroughImages(),
  STORAGE: memoryStorage().bucket,
  STRIPE_PRO_PRICE_ID: screenshotProPrice,
});
fakePlaid();

let dayStart = 0;
let requestsToday = 0;

const request = async (path: string, init: RequestInit = {}) => {
  setSystemTime(new Date(dayStart + requestsToday++ * 60_000));
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

await seedScreenshotData({
  database,
  outbox: outbox.messages,
  request,
  setDay: (day) => {
    // 19:00 UTC: noon in Merrow Bay, on the Pacific coast, in daylight
    // saving time. Steps on one day keep counting, so they stay in order.
    const start = Date.parse(`${day}T19:00:00.000Z`);
    if (start === dayStart) return;
    dayStart = start;
    requestsToday = 0;
  },
});
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
