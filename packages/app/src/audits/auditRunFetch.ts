/**
 * Reading an audit run from the server, for a full reload (after a save,
 * replacing the audit and its answers) or an issues refresh (keeping unsaved
 * answers). Only the newest read may land, but a newer issues refresh must
 * not lose an older full reload's purpose: the fetch it replaces stays full,
 * and so does a failed full reload until a read lands.
 */
export type AuditRunFetch =
  | { status: "idle" }
  | { full: boolean; request: number; status: "fetching" }
  | { full: boolean; message: string; status: "failed" };

export type AuditRunFetchEvent =
  | { full: boolean; request: number; type: "started" }
  | { request: number; type: "landed" }
  | { message: string; request: number; type: "failed" };

export const initialAuditRunFetch: AuditRunFetch = { status: "idle" };

const current = (state: AuditRunFetch, request: number) =>
  state.status === "fetching" && state.request === request;

export function auditRunFetchTransition(
  state: AuditRunFetch,
  event: AuditRunFetchEvent,
): AuditRunFetch {
  switch (event.type) {
    case "started":
      return {
        // A pending or failed full reload still needs the audit replaced.
        full: event.full || (state.status !== "idle" && state.full),
        request: event.request,
        status: "fetching",
      };
    case "landed":
      return current(state, event.request) ? initialAuditRunFetch : state;
    case "failed":
      return state.status === "fetching" && state.request === event.request
        ? { full: state.full, message: event.message, status: "failed" }
        : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown audit run fetch event: ${JSON.stringify(event)}`);
}
