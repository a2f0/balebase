/** Thrown when a body is still arriving at its read deadline. */
export class BodyReadTimeoutError extends Error {}

function cancelBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
) {
  // Cancellation is cleanup, not part of the upload deadline. A hostile or
  // broken source may never settle its cancel hook, so observe rejection
  // without letting that hook retain the global and organization upload slots.
  void reader.cancel(reason).catch(() => undefined);
}

/**
 * Reads a stream with fixed memory: null once it would exceed `maxBytes`.
 * With a timeout, a body still arriving at the deadline is cancelled and
 * rejects with a BodyReadTimeoutError.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMilliseconds?: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  const timeoutError = new BodyReadTimeoutError("body read deadline exceeded");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    if (timeoutMilliseconds === undefined) return;
    timeout = setTimeout(() => reject(timeoutError), timeoutMilliseconds);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return bytes.subarray(0, total);
      if (total + value.byteLength > maxBytes) {
        cancelBodyReader(reader, "request body exceeded its size limit");
        return null;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (cause) {
    if (cause === timeoutError) {
      cancelBodyReader(reader, timeoutError);
    }
    throw cause;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
}
