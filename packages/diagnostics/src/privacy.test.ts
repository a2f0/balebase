import { expect, test } from "bun:test";
import type { Event } from "@sentry/core";
import { browserConfig, isSentryBuild, type SentryConfig } from "./config";
import { sanitizeSentryEvent } from "./privacy";

const config: SentryConfig = {
  dsn: `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1`,
  environment: "staging",
  release: `balebase-web@${"b".repeat(40)}`,
  target: "web",
  origin: "https://app-staging.balebase.com",
  paths: new Set(["/assets/index-123.js"]),
};

test("reconstructs only approved code positions and release metadata", () => {
  const event: Event = {
    event_id: "c".repeat(32),
    tags: { diagnostic_source: "boundary", account: "private" },
    message: "private",
    user: { email: "private" },
    request: {
      url: "https://app.balebase.com/signing/private",
      headers: { Authorization: "private" },
      data: "private",
    },
    extra: { value: "private" },
    contexts: { secret: { value: "private" } },
    breadcrumbs: [{ message: "private", data: { text: "private" } }],
    exception: {
      values: [
        {
          type: "private",
          value: "private",
          stacktrace: {
            frames: [
              { filename: "https://extension.example/private", lineno: 1 },
              { filename: `${config.origin}/assets/private.js`, lineno: 1 },
              {
                filename: `${config.origin}/assets/index-123.js?private#private`,
                lineno: 25,
                colno: 8,
                function: "private",
                vars: { password: "private" },
                pre_context: ["private"],
              },
            ],
          },
        },
      ],
    },
  };
  const sanitized = sanitizeSentryEvent(event, config);
  expect(JSON.stringify(sanitized)).not.toContain("private");
  expect(sanitized?.exception?.values?.[0]).toMatchObject({
    type: "Error",
    value: "Application error (message omitted)",
    stacktrace: {
      frames: [
        {
          filename: "app:///assets/index-123.js",
          lineno: 25,
          colno: 8,
          in_app: true,
        },
      ],
    },
  });
  expect(sanitized?.user).toEqual({ ip_address: "0.0.0.0" });
  expect(sanitizeSentryEvent(sanitized as Event, config)).toEqual(sanitized);
});

test("drops foreign errors and non-error events, retaining explicit boundaries", () => {
  expect(
    sanitizeSentryEvent(
      { tags: { diagnostic_source: "unhandled-error" } },
      config,
    ),
  ).toBeNull();
  expect(
    sanitizeSentryEvent(
      { tags: { diagnostic_source: "request-error" } },
      config,
    ),
  ).toBeNull();
  expect(
    sanitizeSentryEvent(
      { type: "transaction", tags: { diagnostic_source: "boundary" } },
      config,
    ),
  ).toBeNull();
  expect(
    sanitizeSentryEvent({ tags: { diagnostic_source: "boundary" } }, config),
  ).not.toBeNull();
});

test("Worker bundle frames match source-map artifact names", () => {
  const server = {
    ...config,
    target: "api" as const,
    paths: new Set(["/index.js"]),
    origin: "",
  };
  const sanitized = sanitizeSentryEvent(
    {
      tags: { diagnostic_source: "request-error" },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: "index.js", lineno: 50, colno: 2 },
                { filename: "node:internal/private", lineno: 2 },
              ],
            },
          },
        ],
      },
    },
    server,
  );
  expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames).toEqual([
    { filename: "app:///index.js", lineno: 50, colno: 2, in_app: true },
  ]);
});

test("requires a hosted DSN, commit, environment, and matching asset manifest", () => {
  expect(isSentryBuild(config)).toBe(true);
  for (const change of [
    { environment: "development" },
    { release: "latest" },
    { target: "private" },
    { dsn: "https://example.com/1" },
  ]) {
    expect(isSentryBuild({ ...config, ...change })).toBe(false);
  }
  const manifest = { ...config, paths: [...config.paths] };
  expect(browserConfig(config, manifest, config.origin)?.paths).toEqual(
    config.paths,
  );
  for (const change of [
    { release: "old" },
    { target: "android" },
    { environment: "production" },
    { paths: ["/users/private.js"] },
    { paths: [] },
  ]) {
    expect(
      browserConfig(config, { ...manifest, ...change }, config.origin),
    ).toBeUndefined();
  }
});

test("iOS custom-scheme stack frames retain approved asset positions", () => {
  const native = {
    ...config,
    target: "ios" as const,
    origin: new URL("capacitor://localhost").origin,
  };
  const event: Event = {
    tags: { diagnostic_source: "unhandled-error" },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              {
                filename: "capacitor://localhost/assets/index-123.js",
                lineno: 2,
              },
            ],
          },
        },
      ],
    },
  };
  expect(
    sanitizeSentryEvent(event, native)?.exception?.values?.[0]?.stacktrace
      ?.frames?.[0]?.filename,
  ).toBe("app:///assets/index-123.js");
});
