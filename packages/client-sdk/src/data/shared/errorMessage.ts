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
