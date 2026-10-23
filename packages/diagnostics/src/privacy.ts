import type { ErrorEvent, Event, StackFrame } from "@sentry/core";
import type { SentryConfig } from "./config";

const errorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
const clientSources = new Set([
  "boundary",
  "unhandled-error",
  "unhandled-rejection",
]);
const serverSources = new Set([
  "request-error",
  "email-error",
  "scheduled-error",
]);

function safeFrame(frame: StackFrame, config: SentryConfig): StackFrame | null {
  if (typeof frame.filename !== "string") return null;
  let path: string;
  try {
    const url = new URL(frame.filename);
    path =
      url.protocol === "app:" ||
      url.origin === config.origin ||
      (config.target === "api" && url.href === "file:///index.js")
        ? url.pathname
        : "";
  } catch {
    // Wrangler's deployed module is index.js. Admit that exact bundle only.
    path =
      config.target === "api" &&
      ["index.js", "/index.js"].includes(frame.filename)
        ? "/index.js"
        : "";
  }
  if (
    !config.paths.has(path) ||
    typeof frame.lineno !== "number" ||
    !Number.isSafeInteger(frame.lineno) ||
    (frame.lineno ?? 0) < 1
  )
    return null;
  return {
    filename: `app://${path}`,
    lineno: frame.lineno,
    ...(Number.isSafeInteger(frame.colno) && (frame.colno ?? -1) >= 0
      ? { colno: frame.colno }
      : {}),
    in_app: true,
  };
}

/** Rebuild from a finite allowlist: exception text can contain application data. */
export function sanitizeSentryEvent(
  event: Event,
  config: SentryConfig,
): ErrorEvent | null {
  if (event.type !== undefined) return null;
  const { diagnostic_source: source } = event.tags ?? {};
  const sources = config.target === "api" ? serverSources : clientSources;
  if (typeof source !== "string" || !sources.has(source)) return null;
  const frames = (event.exception?.values?.[0]?.stacktrace?.frames ?? [])
    .map((frame) => safeFrame(frame, config))
    .filter((frame): frame is StackFrame => frame !== null)
    .slice(-40);
  if (!frames.length && source !== "boundary" && config.target !== "api")
    return null;
  const type = event.exception?.values?.[0]?.type ?? "Error";
  return {
    type: undefined,
    ...(typeof event.event_id === "string" &&
    /^[a-f0-9]{32}$/u.test(event.event_id)
      ? { event_id: event.event_id }
      : {}),
    timestamp:
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: config.environment,
    release: config.release,
    dist: config.environment,
    user: { ip_address: "0.0.0.0" },
    tags: {
      target: config.target,
      diagnostic_source: source,
      privacy: "allowlist-v1",
    },
    exception: {
      values: [
        {
          type: errorTypes.has(type) ? type : "Error",
          value: "Application error (message omitted)",
          ...(frames.length ? { stacktrace: { frames } } : {}),
          mechanism: {
            type: "generic",
            handled: !source.startsWith("unhandled-"),
          },
        },
      ],
    },
  };
}
