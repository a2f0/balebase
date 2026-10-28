import type { Context } from "hono";
import { captureApiError } from "./diagnostics";

/**
 * The response and report for an error no route handled. Hono gives a mounted
 * router's own onError precedence over the app's, so routers that map their
 * domain errors must end here too or their failures are never reported.
 */
export function respondToUnexpectedError(error: Error, context: Context) {
  console.error(error);
  const report = captureApiError(error, "request-error");
  try {
    context.executionCtx.waitUntil(report);
  } catch {
    // Local tests have no execution context; a release Worker always does.
    void report;
  }
  return context.json({ error: "Unexpected server error." }, 500);
}
