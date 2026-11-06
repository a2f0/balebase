/**
 * A full reload of the run: it replaces the audit and its answers, except
 * that after a save it keeps every answer changed since the answers that
 * save sent (`keepSince`), since answers stay editable while it runs.
 */
export interface AuditRunReload {
  keepSince?: Record<string, string> | undefined;
}

/**
 * Reading an audit run from the server, for a full reload or an issues
 * refresh (keeping unsaved answers). Only the newest read may land, but a
 * newer issues refresh must not lose an older full reload's purpose: the
 * fetch it replaces stays a reload, and so does a failed reload until a read
 * lands.
 */
export type AuditRunFetch =
  | { status: "idle" }
  | { reload: AuditRunReload | null; request: number; status: "fetching" }
  | { message: string; reload: AuditRunReload | null; status: "failed" };

export type AuditRunFetchEvent =
  /** `reload` is null for an issues refresh. */
  | { reload: AuditRunReload | null; request: number; type: "started" }
  | { request: number; type: "landed" }
  | { message: string; request: number; type: "failed" };

export const initialAuditRunFetch: AuditRunFetch = { status: "idle" };

export function auditRunFetchTransition(
  state: AuditRunFetch,
  event: AuditRunFetchEvent,
): AuditRunFetch {
  switch (event.type) {
    case "started":
      return {
        // A pending or failed reload still needs the audit replaced.
        reload: event.reload ?? (state.status === "idle" ? null : state.reload),
        request: event.request,
        status: "fetching",
      };
    case "landed":
      return state.status === "fetching" && state.request === event.request
        ? initialAuditRunFetch
        : state;
    case "failed":
      return state.status === "fetching" && state.request === event.request
        ? { message: event.message, reload: state.reload, status: "failed" }
        : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown audit run fetch event: ${JSON.stringify(event)}`);
}
