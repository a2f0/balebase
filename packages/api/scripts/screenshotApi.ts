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

/**
 * The real Worker app over an in-memory database with every migration
 * applied, seeded from the continuity genesis. Nothing leaves the process:
 * email lands in an in-memory outbox, storage is a map, images keep their
 * bytes, Plaid is a fake answering with the continuity bank feed, and the
 * auth secret is a fixed placeholder, so no `.secrets` are read.
 *
 * Seeding runs on a fixed clock: each step starts at noon in Merrow Bay on
 * the canon day it happened, and the clock advances a minute per request, so
 * every capture shows the same timestamps in the same order. The clock is
 * real again when this resolves, so later sessions stay current. Call
 * `restore` to give `fetch` back.
 */
export async function seededScreenshotApi(origins: {
  api: string;
  app: string;
}) {
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
    BETTER_AUTH_URL: origins.api,
    CORS_ORIGIN: origins.app,
    DB: toD1(database),
    EMAIL: outbox.binding,
    FINANCE_SYNC_QUEUE: inlineSyncQueue(() => bindings),
    IMAGES: passThroughImages(),
    STORAGE: memoryStorage().bucket,
    STRIPE_PRO_PRICE_ID: screenshotProPrice,
  });
  const restore = fakePlaid();

  let dayStart = 0;
  let requestsToday = 0;
  const request = async (path: string, init: RequestInit = {}) => {
    setSystemTime(new Date(dayStart + requestsToday++ * 60_000));
    const headers = new Headers(init.headers);
    headers.set("origin", origins.app);
    headers.set("cf-connecting-ip", "127.0.0.1");
    const response = await app.fetch(
      new Request(`${origins.api}${path}`, { ...init, headers }),
      bindings,
      executionContext,
    );
    await Promise.all(pending?.splice(0) ?? []);
    return response;
  };

  try {
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
  } catch (error) {
    restore();
    throw error;
  } finally {
    setSystemTime();
    pending = undefined;
  }
  return { bindings, database, executionContext, restore };
}
