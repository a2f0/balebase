import type { ErrorBody } from "@balebase/validators/route";

/** A response the API refused or failed, with the message it gave. */
export class ApiError extends Error {
  /** The API's error body, when it sent one. */
  readonly body: ErrorBody | null;
  /** The response's JSON whatever its shape, or null when it had none. */
  readonly data: unknown;
  /** A code the client branches on, such as `UPGRADE_REQUIRED`. */
  readonly code: string | undefined;
  /** The response itself, for its status and headers such as Retry-After. */
  readonly response: Response;

  constructor(response: Response, data: unknown) {
    const body = isErrorBody(data) ? data : null;
    super(body?.error ?? `Request failed with status ${response.status}.`);
    this.name = "ApiError";
    this.body = body;
    this.data = data;
    this.code = body?.code;
    this.response = response;
  }

  get status() {
    return this.response.status;
  }

  static async from(response: Response) {
    return new ApiError(response, await response.json().catch(() => null));
  }
}

function isErrorBody(data: unknown): data is ErrorBody {
  if (typeof data !== "object" || data === null) return false;
  const { code, error } = data as Record<string, unknown>;
  return (
    typeof error === "string" &&
    (code === undefined || typeof code === "string")
  );
}
