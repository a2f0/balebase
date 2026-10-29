import type { Bindings } from "../types";

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
  let timedOut = false;
  let failRead: ((cause: unknown) => void) | undefined;
  const timeout =
    timeoutMilliseconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          failRead?.(timeoutError);
        }, timeoutMilliseconds);
  // Only the read in progress can be failed by the deadline. Racing every
  // read against one pending deadline promise would retain a handler per
  // chunk, so a body sent in tiny pieces could exhaust memory.
  const read = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      if (timedOut) return reject(timeoutError);
      failRead = reject;
      reader.read().then(resolve, reject);
    });
  try {
    while (true) {
      const { done, value } = await (timeout === undefined
        ? reader.read()
        : read());
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

interface Download {
  /** "inline" lets the browser show the file; the default saves it. */
  disposition?: "attachment" | "inline";
  /** An ASCII name for clients that ignore `filename*`. */
  fallbackFilename: string;
  /** The real name, sent percent-encoded as `filename*`. */
  filename?: string;
  /** Headers that replace the stored ones, such as the content type. */
  headers?: Record<string, string>;
}

/**
 * The Content-Disposition for a download. `'` is escaped along with what
 * encodeURIComponent escapes, because it delimits the charset and language
 * in an RFC 5987 `filename*` value.
 */
export function contentDisposition({
  disposition = "attachment",
  fallbackFilename,
  filename,
}: Download) {
  const header = `${disposition}; filename="${fallbackFilename}"`;
  if (filename === undefined) return header;
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27");
  return `${header}; filename*=UTF-8''${encoded}`;
}

/** Serves a stored object as a file the browser will not content-sniff. */
export function downloadResponse(object: R2ObjectBody, download: Download) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-disposition", contentDisposition(download));
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  for (const [name, value] of Object.entries(download.headers ?? {})) {
    headers.set(name, value);
  }
  return new Response(object.body, { headers });
}

/** The object at `key` as a download, or null when storage has no bytes. */
export async function storedDownload(
  storage: R2Bucket,
  key: string,
  download: Download,
) {
  const object = await storage.get(key);
  return object ? downloadResponse(object, download) : null;
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

interface TrackedUpload {
  /** The cleanup record's ID, unique to this upload. */
  cleanupId: string;
  key: string;
  organizationId: string;
}

/**
 * Writes an object that a D1 row will reference, queueing its key for the
 * deleted-object cleanup first so a write that fails or loses its response
 * never leaves untracked bytes. The referencing row claims the key: its write
 * must hold `uploadStillQueued`, and a trigger then deletes the record.
 */
export async function trackedPut(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  upload: TrackedUpload,
  value: Parameters<R2Bucket["put"]>[1],
  options: R2PutOptions,
) {
  await environment.DB.prepare(
    `INSERT INTO deleted_object_cleanup
       (id, organization_id, object_key, deleted_at, cleanup_token,
        cleanup_claimed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      upload.cleanupId,
      upload.organizationId,
      upload.key,
      new Date().toISOString(),
    )
    .run();
  await environment.STORAGE.put(upload.key, value, options);
}

/**
 * Holds, with the upload's key bound, while the cleanup has not claimed the
 * upload, so a slow write never links bytes the cleanup is deleting.
 */
export const uploadStillQueued = `EXISTS (
  SELECT 1 FROM deleted_object_cleanup
  WHERE object_key = ? AND cleanup_token IS NULL
)`;

export const uploadExpired =
  "The upload took too long to save. Please try again.";
