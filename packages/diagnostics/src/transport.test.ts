import { afterEach, expect, spyOn, test } from "bun:test";
import type { ErrorEvent, Event } from "@sentry/core";
import { createSentryEventBudget } from "./budget";
import type { SentryConfig } from "./config";
import { captureServerError } from "./server";
import { createPrivateTransport } from "./transport";

const config: SentryConfig = {
  dsn: `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1`,
  environment: "staging",
  release: `balebase-api@${"b".repeat(40)}`,
  target: "api",
  origin: "",
  paths: new Set(["/index.js"]),
};
const fetches: RequestInit[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  fetches.length = 0;
});
function intercept() {
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      fetches.push(init ?? {});
      return new Response("{}", { status: 200 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

test("the transport drops non-errors and sanitizes envelope headers and payloads again", async () => {
  intercept();
  const transport = createPrivateTransport(config)({
    url: "https://example.com",
    recordDroppedEvent: () => {},
  });
  const payload: Event = {
    tags: { diagnostic_source: "request-error" },
    message: "private",
    request: { data: "private" },
  };
  await transport.send([
    { sent_at: new Date().toISOString() },
    [[{ type: "session" }, {} as never]],
  ]);
  await transport.send([
    {
      event_id: "c".repeat(32),
      sent_at: new Date().toISOString(),
      trace: { transaction: "private" },
    },
    [
      [{ type: "attachment", length: 7, filename: "private" }, "private"],
      [{ type: "event" }, payload],
    ],
  ]);
  await transport.flush(1000);
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatchObject({
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const body = String(fetches[0]?.body);
  expect(body).not.toContain("private");
  expect(body).not.toContain('"session"');
  expect(body).not.toContain('"attachment"');
  expect(body).toContain('"type":"event"');
});

test("the real server SDK sends only sanitized errors and swallows network failures", async () => {
  intercept();
  const error = new TypeError("private account information");
  error.stack = "TypeError: private\n    at customer_private (index.js:42:5)";
  await captureServerError(config, error, "email-error");
  expect(fetches).toHaveLength(1);
  expect(String(fetches[0]?.body)).toContain('"filename":"app:///index.js"');
  expect(String(fetches[0]?.body)).not.toContain("private");
  await captureServerError(undefined, error, "email-error");
  expect(fetches).toHaveLength(1);
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("network unavailable");
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(
    captureServerError(config, new Error("other"), "scheduled-error"),
  ).resolves.toBeUndefined();
});

test("budgets deduplicate, rate-limit and reset bounded server reporting", () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const admit = createSentryEventBudget(3_600_000);
    const event = (index: number): ErrorEvent => ({
      type: undefined,
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [{ filename: "app:///index.js", lineno: index }],
            },
          },
        ],
      },
    });
    expect(admit(event(1))).toBe(true);
    expect(admit(event(1))).toBe(false);
    for (let index = 2; index <= 5; index++)
      expect(admit(event(index))).toBe(true);
    expect(admit(event(6))).toBe(false);
    for (let minute = 1; minute <= 3; minute++) {
      now += 60_000;
      for (let index = 1; index <= 5; index++)
        expect(admit(event(minute * 5 + index))).toBe(true);
    }
    now += 60_000;
    expect(admit(event(21))).toBe(false);
    now = 3_600_000;
    expect(admit(event(1))).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
