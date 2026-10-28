import type { Bindings } from "../types";

interface RequestTarget {
  request: (
    input: string,
    init: RequestInit | undefined,
    env: Bindings,
    executionContext?: ExecutionContext,
  ) => Response | Promise<Response>;
}

export interface TestResponse<T> {
  /** Parsed JSON, the text of any other body, or null when empty. */
  body: T;
  headers: Headers;
  status: number;
}

/**
 * Sends requests to `app` with `bindings` and reads each response. A plain
 * object body is sent as JSON; strings, forms, and blobs are sent as given.
 */
export function requester(
  app: RequestTarget,
  bindings: Bindings | (() => Bindings),
  defaults: {
    executionContext?: ExecutionContext;
    headers?: Record<string, string>;
  } = {},
) {
  return async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<TestResponse<T>> => {
    const init: RequestInit = {
      headers: { ...defaults.headers, ...headers },
      method,
    };
    if (body !== undefined) Object.assign(init, encodeBody(body, init));
    const response = await app.request(
      path,
      init,
      typeof bindings === "function" ? bindings() : bindings,
      defaults.executionContext,
    );
    return {
      body: (await readBody(response)) as T,
      headers: response.headers,
      status: response.status,
    };
  };
}

function encodeBody(body: unknown, init: RequestInit) {
  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ArrayBuffer ||
    body instanceof Uint8Array ||
    body instanceof ReadableStream
  )
    return { body: body as BodyInit };
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...init.headers },
  };
}

async function readBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  return response.headers.get("content-type")?.includes("json")
    ? JSON.parse(text)
    : text;
}

export interface FetchCall {
  body: string;
  headers: Headers;
  method: string;
  url: string;
}

type FetchRoute = (call: FetchCall) => Response | Promise<Response>;

/**
 * Replaces `fetch` while `run` executes. Each route key is "METHOD URL",
 * where `*` matches any run of characters. A request no route matches is
 * rejected and fails the call even if the code under test swallows it.
 * `calls` records every request in order. `fetch` and, with
 * `captureErrors`, `console.error` are restored afterwards.
 */
export async function withFetch<T>(
  routes: Record<string, FetchRoute>,
  run: (calls: { errors: unknown[][]; requests: FetchCall[] }) => Promise<T>,
  options: { captureErrors?: boolean } = {},
) {
  const patterns = Object.entries(routes).map(
    ([key, route]) => [routePattern(key), route] as const,
  );
  const calls = { errors: [] as unknown[][], requests: [] as FetchCall[] };
  const unmatched: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call = {
      body: await request.text(),
      headers: request.headers,
      method: request.method,
      url: request.url,
    };
    calls.requests.push(call);
    const target = `${call.method} ${call.url}`;
    const route = patterns.find(([pattern]) => pattern.test(target))?.[1];
    if (route) return route(call);
    unmatched.push(target);
    throw new TypeError(`No test route for ${target}`);
  }) as typeof fetch;
  if (options.captureErrors)
    console.error = (...values: unknown[]) => calls.errors.push(values);
  try {
    const result = await run(calls);
    if (unmatched.length)
      throw new Error(`Unrouted fetch calls: ${unmatched.join(", ")}`);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

function routePattern(key: string) {
  const escaped = key
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
