import { describe, expect, it } from "bun:test";
import {
  BodyReadTimeoutError,
  contentDisposition,
  readBodyWithLimit,
  readBoundedRequest,
} from "./storage";

function streamOf(chunks: Uint8Array[]) {
  const progress = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[progress.pulled];
      progress.pulled += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return { body, progress };
}

describe("download headers", () => {
  it("percent-encodes the real filename, including its apostrophes", () => {
    expect(
      contentDisposition({
        fallbackFilename: "download",
        filename: 'Dana\'s café; "notes".txt',
      }),
    ).toBe(
      `attachment; filename="download"; filename*=UTF-8''Dana%27s%20caf%C3%A9%3B%20%22notes%22.txt`,
    );
    expect(
      contentDisposition({
        disposition: "inline",
        fallbackFilename: "thumbnail.webp",
      }),
    ).toBe('inline; filename="thumbnail.webp"');
  });
});

describe("bounded body reads", () => {
  it("keeps every byte while the buffer grows toward the limit", async () => {
    const chunks = [40_000, 90_000, 300_000].map((size, index) =>
      new Uint8Array(size).fill(index + 1),
    );
    const { body } = streamOf(chunks);
    const bytes = await readBodyWithLimit(body, 430_000);
    expect(bytes).toEqual(
      new Uint8Array([
        ...new Uint8Array(40_000).fill(1),
        ...new Uint8Array(90_000).fill(2),
        ...new Uint8Array(300_000).fill(3),
      ]),
    );
  });

  it.each([undefined, 60_000])(
    "holds nothing per chunk while a body arrives in tiny pieces (timeout %p)",
    async (timeout) => {
      const chunkCount = 200_000;
      const chunk = new Uint8Array([7]);
      let heapAtLastChunk = 0;
      let pulled = 0;
      Bun.gc(true);
      const heapBefore = process.memoryUsage().heapUsed;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > chunkCount) return controller.close();
          if (pulled === chunkCount) {
            Bun.gc(true);
            heapAtLastChunk = process.memoryUsage().heapUsed;
          }
          controller.enqueue(chunk);
        },
      });
      const bytes = await readBodyWithLimit(body, chunkCount, timeout);
      expect(bytes?.byteLength).toBe(chunkCount);
      // Per-chunk timeout handlers would retain tens of megabytes here.
      expect(heapAtLastChunk - heapBefore).toBeLessThan(8 * 1024 * 1024);
    },
  );

  it("cancels a body still arriving at its deadline", async () => {
    let cancelled: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const read = readBodyWithLimit(body, 10, 20);
    await expect(read).rejects.toBeInstanceOf(BodyReadTimeoutError);
    expect(cancelled).toBeInstanceOf(BodyReadTimeoutError);
  });

  it("refuses an advertised oversized body without reading it", async () => {
    const { body } = streamOf([new Uint8Array(8)]);
    const request = new Request("https://api.test/upload", {
      body,
      headers: { "content-length": "8" },
      method: "POST",
    });
    expect(await readBoundedRequest(request, 7)).toBeNull();
    expect(request.bodyUsed).toBe(false);
  });
});
