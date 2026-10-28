import { describe, expect, it } from "bun:test";
import { readBodyWithLimit, readBoundedRequest } from "./storage";

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
