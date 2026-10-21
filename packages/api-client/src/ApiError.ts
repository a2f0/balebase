import { type ErrorBody, ErrorBodySchema } from "@balebase/validators/route";

/** A response the API refused or failed, with the message it gave. */
export class ApiError extends Error {
  /** The API's error body, when it sent one. */
  readonly body: ErrorBody | null;
  /** A code the client branches on, such as `UPGRADE_REQUIRED`. */
  readonly code: string | undefined;
  /** The response itself, for its status and headers such as Retry-After. */
  readonly response: Response;

  constructor(response: Response, body: ErrorBody | null) {
    super(body?.error ?? `Request failed with status ${response.status}.`);
    this.name = "ApiError";
    this.body = body;
    this.code = body?.code;
    this.response = response;
  }

  get status() {
    return this.response.status;
  }

  static async from(response: Response) {
    const parsed = ErrorBodySchema.safeParse(
      await response.json().catch(() => null),
    );
    return new ApiError(response, parsed.success ? parsed.data : null);
  }
}
