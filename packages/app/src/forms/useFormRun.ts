import type { FormDetail } from "@balebase/validators/forms";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { balebase } from "../balebase";
import { errorMessage } from "../shared/errors";
import {
  type FormRunFetch,
  type FormRunFetchEvent,
  type FormRunReload,
  formRunFetchTransition,
  initialFormRunFetch,
} from "./formRunFetch";

interface RunState {
  detail: FormDetail | undefined;
  responses: Record<string, string>;
}

type RunAction =
  | { deletedAt: string; type: "discarded" }
  | {
      detail: FormDetail;
      /** Keep answers changed since these (the ones a save sent). */
      keepSince?: Record<string, string> | undefined;
      type: "loaded";
    }
  | { detail: FormDetail; type: "issuesRefreshed" }
  | { itemId: string; response: string; type: "answered" };

/**
 * The run page's form and answers. Issue changes refresh the form without
 * discarding unsaved answers, so a Fail survives raising its issue.
 */
export function runStateReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "loaded":
      return {
        detail: action.detail,
        responses: {
          ...action.detail.form.responses,
          ...editedSince(state.responses, action.keepSince),
        },
      };
    case "issuesRefreshed":
      return {
        ...state,
        detail: {
          ...action.detail,
          form: state.detail?.form ?? action.detail.form,
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
              form: { ...state.detail.form, deletedAt: action.deletedAt },
            },
            responses: state.detail.form.responses,
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
 * issue refreshes, so this guards its own reads (`formRunFetch.ts`): only
 * the newest lands, and an issues refresh that replaces a pending or failed
 * reload carries that reload out, keeping what it would have kept.
 */
export function useFormRun(id: string) {
  const [{ detail, responses }, dispatch] = useReducer(runStateReducer, {
    detail: undefined,
    responses: {},
  });
  // The read machine lives in a ref, so a read's result is checked against
  // the latest state synchronously; the copy renders its error.
  const fetching = useRef<FormRunFetch>(initialFormRunFetch);
  const [fetch, setFetch] = useState<FormRunFetch>(initialFormRunFetch);
  const latest = useRef(0);
  const send = useCallback((event: FormRunFetchEvent) => {
    const before = fetching.current;
    fetching.current = formRunFetchTransition(before, event);
    setFetch(fetching.current);
    return before;
  }, []);

  const fetchRun = useCallback(
    async (reload: FormRunReload | null) => {
      const request = ++latest.current;
      send({ reload, request, type: "started" });
      try {
        const next = await balebase().api.forms.getRun(id);
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
          message: errorMessage(cause, "Could not load the form."),
          request,
          type: "failed",
        });
      }
    },
    [id, send],
  );
  /** Reloads the run; without `reload`, unsaved answers are replaced. */
  const load = useCallback(
    (reload: FormRunReload = {}) => fetchRun(reload),
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
