/** Thrown when a body is still arriving at its read deadline. */
export class BodyReadTimeoutError extends Error {}

const initialBodyBufferBytes = 64 * 1024;
// Room for a form's boundaries, part headers, and small text fields.
const multipartOverheadBytes = 256 * 1024;

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
 * Reads a stream into memory, returning null as soon as it would exceed
 * `maxBytes`. The buffer grows with the body, so a small body does not
 * reserve the whole limit. With a timeout, a body still arriving at the
 * deadline is cancelled and rejects with a BodyReadTimeoutError.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMilliseconds?: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  let bytes = new Uint8Array(Math.min(maxBytes, initialBodyBufferBytes));
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
      const end = total + value.byteLength;
      if (end > maxBytes) {
        cancelBodyReader(reader, "request body exceeded its size limit");
        return null;
      }
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(end, bytes.byteLength * 2)),
        );
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(value, total);
      total = end;
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

/**
 * Reads a request body of at most `maxBytes`, or null when it is larger.
 * The bytes are exactly what the client sent, so a signature over them
 * still verifies.
 */
export async function readBoundedRequest(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  return readBodyWithLimit(request.body, maxBytes);
}

/**
 * Parses a multipart upload whose file may be up to `maxFileBytes`, refusing
 * a larger body while it streams rather than after buffering all of it.
 * Callers still check the file's own size. Null when the body is not a
 * readable multipart form.
 */
export async function readBoundedForm(request: Request, maxFileBytes: number) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return null;
  }
  const bytes = await readBoundedRequest(
    request,
    maxFileBytes + multipartOverheadBytes,
  );
  if (bytes === null) return "too_large" as const;
  return new Response(bytes, { headers: { "content-type": contentType } })
    .formData()
    .catch(() => null);
}
