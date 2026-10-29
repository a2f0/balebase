import type {
  DiagnosticSource,
  SentryBuild,
} from "@balebase/diagnostics/config";
import { captureServerError } from "@balebase/diagnostics/server";

declare const API_SENTRY_BUILD: SentryBuild | undefined;

export function captureApiError(error: unknown, source: DiagnosticSource) {
  return captureServerError(
    typeof API_SENTRY_BUILD === "undefined" ? undefined : API_SENTRY_BUILD,
    error,
    source,
  );
}
