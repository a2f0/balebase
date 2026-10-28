/** An error whose fix is a Pro upgrade on the Billing page. */
export class UpgradeRequiredError extends Error {
  readonly code = "UPGRADE_REQUIRED";
}

export interface ErrorNotice {
  message: string;
  /** The API marked it `UPGRADE_REQUIRED`, so Billing can resolve it. */
  upgrade: boolean;
}

// fetch rejects with a TypeError that each browser engine words differently.
const networkFailure =
  /failed to fetch|networkerror|load failed|network connection|internet connection/i;

/** Text to show for a failed request or action; `fallback` covers non-errors. */
export function errorMessage(cause: unknown, fallback: string) {
  if (!(cause instanceof Error)) return fallback;
  if (cause.name === "TimeoutError")
    return "The request took too long. Try again.";
  if (cause.name === "AbortError") return "The request was cancelled.";
  if (cause instanceof TypeError && networkFailure.test(cause.message))
    return "Could not connect. Check your connection and try again.";
  return cause.message || fallback;
}

/** Better Auth reports a refused request in `error` instead of throwing. */
export function throwIfRefused(
  error: { message?: string | undefined } | null,
  fallback: string,
) {
  if (error) throw new Error(error.message ?? fallback);
}

export function errorNotice(cause: unknown, fallback: string): ErrorNotice {
  return {
    message: errorMessage(cause, fallback),
    upgrade:
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "UPGRADE_REQUIRED",
  };
}
