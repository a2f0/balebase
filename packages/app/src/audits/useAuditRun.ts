import type { AuditDetail } from "@balebase/validators/audits";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import {
  type AuditRunFetch,
  type AuditRunFetchEvent,
  type AuditRunReload,
  auditRunFetchTransition,
  initialAuditRunFetch,
} from "./auditRunFetch";

interface RunState {
  detail: AuditDetail | undefined;
  responses: Record<string, string>;
}

type RunAction =
  | { deletedAt: string; type: "discarded" }
  | {
      detail: AuditDetail;
      /** Keep answers changed since these (the ones a save sent). */
      keepSince?: Record<string, string> | undefined;
      type: "loaded";
    }
  | { detail: AuditDetail; type: "issuesRefreshed" }
  | { itemId: string; response: string; type: "answered" };

/**
 * The run page's audit and answers. Issue changes refresh the audit without
 * discarding unsaved answers, so a Fail survives raising its issue.
 */
export function runStateReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "loaded":
      return {
        detail: action.detail,
        responses: {
          ...action.detail.audit.responses,
          ...editedSince(state.responses, action.keepSince),
        },
      };
    case "issuesRefreshed":
      return {
        ...state,
        detail: {
          ...action.detail,
          audit: state.detail?.audit ?? action.detail.audit,
        },
      };
    case "answered":
      return {
        ...state,
        responses: { ...state.responses, [action.itemId]: action.response },
      };
    // Read-only at once, even if the reload that follows fails; unsaved
    // answers were not kept, so show the saved ones.
    case "discarded":
      return state.detail
        ? {
            detail: {
              ...state.detail,
              audit: { ...state.detail.audit, deletedAt: action.deletedAt },
            },
            responses: state.detail.audit.responses,
          }
        : state;
  }
}

/** Answers changed since `since`; none without it. */
function editedSince(
  responses: Record<string, string>,
  since: Record<string, string> | undefined,
) {
  if (!since) return {};
  return Object.fromEntries(
    Object.entries(responses).filter(([id, value]) => since[id] !== value),
  );
}

/**
 * The run and its unsaved answers. The reducer keeps those answers across
 * issue refreshes, so this guards its own reads (`auditRunFetch.ts`): only
 * the newest lands, and an issues refresh that replaces a pending or failed
 * reload carries that reload out, keeping what it would have kept.
 */
export function useAuditRun(id: string) {
  const [{ detail, responses }, dispatch] = useReducer(runStateReducer, {
    detail: undefined,
    responses: {},
  });
  // The read machine lives in a ref, so a read's result is checked against
  // the latest state synchronously; the copy renders its error.
  const fetching = useRef<AuditRunFetch>(initialAuditRunFetch);
  const [fetch, setFetch] = useState<AuditRunFetch>(initialAuditRunFetch);
  const latest = useRef(0);
  const send = useCallback((event: AuditRunFetchEvent) => {
    const before = fetching.current;
    fetching.current = auditRunFetchTransition(before, event);
    setFetch(fetching.current);
    return before;
  }, []);

  const fetchRun = useCallback(
    async (reload: AuditRunReload | null) => {
      const request = ++latest.current;
      send({ reload, request, type: "started" });
      try {
        const next = await api.audits.getRun(id);
        // Unmounting retires every read in flight (the counter moves on).
        const state = fetching.current;
        if (request !== latest.current) return;
        if (state.status !== "fetching" || state.request !== request) return;
        send({ request, type: "landed" });
        dispatch(
          state.reload
            ? {
                detail: next,
                keepSince: state.reload.keepSince,
                type: "loaded",
              }
            : { detail: next, type: "issuesRefreshed" },
        );
      } catch (cause) {
        if (request !== latest.current) return;
        send({
          message: errorMessage(cause, "Could not load the audit."),
          request,
          type: "failed",
        });
      }
    },
    [id, send],
  );
  /** Reloads the run; without `reload`, unsaved answers are replaced. */
  const load = useCallback(
    (reload: AuditRunReload = {}) => fetchRun(reload),
    [fetchRun],
  );
  const refreshIssues = useCallback(() => fetchRun(null), [fetchRun]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);
  const loadError = fetch.status === "failed" ? fetch.message : undefined;
  return { detail, dispatch, load, loadError, refreshIssues, responses };
}
