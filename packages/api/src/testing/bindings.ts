import type { Bindings } from "../types";

/**
 * Complete Worker bindings for a test. Bindings a test does not pass throw a
 * descriptive error when used, rather than standing in as empty objects.
 */
export function testBindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.balebase.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: unavailable<D1Database>("DB"),
    EMAIL: {
      send: async () => ({ messageId: "test-message" }),
    } as unknown as SendEmail,
    IMAGES: unavailable<ImagesBinding>("IMAGES"),
    INBOUND_EMAIL_DOMAIN: "inbox.balebase.com",
    STORAGE: unavailable<R2Bucket>("STORAGE"),
    ...overrides,
  };
}

function unavailable<T extends object>(name: string) {
  return new Proxy({} as T, {
    get: (_target, property) => {
      // Promise resolution and inspection probe these without using the binding.
      if (typeof property === "symbol" || property === "then") return undefined;
      throw new Error(
        `The test bindings have no ${name}; pass one to testBindings to use ${name}.${property}.`,
      );
    },
  });
}

/**
 * An R2 bucket backed by a map, for routes that store and serve objects.
 * `afterPut` runs once the bytes are stored; throwing from it models a write
 * that landed but whose response was lost.
 */
export function memoryStorage(
  stored = new Map<string, Uint8Array>(),
  hooks: {
    afterPut?: (key: string) => void | Promise<void>;
    beforePut?: (key: string) => void | Promise<void>;
  } = {},
) {
  const bucket = {
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key);
    },
    get: async (key: string) => {
      const content = stored.get(key);
      if (!content) return null;
      return {
        arrayBuffer: async () => content.slice().buffer,
        body: new Blob([content]).stream(),
        httpEtag: '"test-etag"',
        size: content.byteLength,
        text: async () => new TextDecoder().decode(content),
        writeHttpMetadata: (headers: Headers) => {
          headers.set("content-type", "application/octet-stream");
        },
      };
    },
    head: async (key: string) =>
      stored.has(key) ? { key, size: stored.get(key)?.byteLength } : null,
    put: async (key: string, value: unknown) => {
      await hooks.beforePut?.(key);
      stored.set(key, await toBytes(value));
      await hooks.afterPut?.(key);
      return { key };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, stored };
}

async function toBytes(value: unknown) {
  if (value instanceof ReadableStream)
    throw new Error("R2 put requires a body with a known length.");
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error(`Unsupported R2 test value: ${typeof value}`);
}
