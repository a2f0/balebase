import type { PlaidLinkDiagnostics } from "@balebase/validators/finance";
import { api } from "../shared/apiClient";

type LinkEvent = PlaidLinkDiagnostics["events"][number];

/** Which Link flow a session runs, for its diagnostics report. */
export interface PlaidLinkSession {
  connectionId: string | undefined;
  oauthResume: boolean;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : null;

/**
 * Records Link's event trail and reports it to the API when the session ends,
 * because an error inside Link (after the bank login, before onSuccess)
 * otherwise leaves no trace outside the user's browser.
 */
export function linkDiagnostics(session: PlaidLinkSession) {
  const events: LinkEvent[] = [];
  const report = (
    outcome: PlaidLinkDiagnostics["outcome"],
    error: PlaidLinkError | null,
    metadata: PlaidLinkExitMetadata,
  ) => {
    // Diagnostics are best effort; they must never block or fail the flow.
    api.finance
      .reportPlaidLinkDiagnostics({
        connectionId: session.connectionId ?? null,
        error: error && {
          displayMessage: text(error.display_message, 1000),
          errorCode: text(error.error_code, 100),
          errorMessage: text(error.error_message, 1000),
          errorType: text(error.error_type, 100),
        },
        events: events.slice(-200),
        institutionId: text(metadata.institution?.institution_id, 100),
        institutionName: text(metadata.institution?.name, 200),
        linkSessionId: text(metadata.link_session_id, 100),
        mode: session.connectionId ? "update" : "create",
        oauthResume: session.oauthResume,
        outcome,
        requestId: text(metadata.request_id, 100),
        status: text(metadata.status, 100),
      })
      .catch(() => undefined);
  };
  return {
    onEvent(eventName: string, metadata: PlaidLinkEventMetadata) {
      events.push({
        errorCode: text(metadata.error_code, 100),
        errorMessage: text(metadata.error_message, 1000),
        errorType: text(metadata.error_type, 100),
        eventName: text(eventName, 100),
        exitStatus: text(metadata.exit_status, 100),
        requestId: text(metadata.request_id, 100),
        timestamp: text(metadata.timestamp, 100),
        viewName: text(metadata.view_name, 100),
      });
    },
    report,
  };
}

/** Link's error for the user, with the code and session Plaid support needs. */
export function linkErrorMessage(
  error: PlaidLinkError | null,
  metadata: PlaidLinkExitMetadata,
) {
  if (!error) return undefined;
  const message =
    error.display_message ?? error.error_message ?? "Plaid Link failed.";
  const details = [
    error.error_code,
    metadata.link_session_id && `session ${metadata.link_session_id}`,
  ].filter(Boolean);
  return details.length ? `${message} (${details.join(", ")})` : message;
}
