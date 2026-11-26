import { errorMessage } from "@balebase/client-sdk";
import { Banner, Button, LoadingState, Toast } from "@balebase/ui/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { balebase } from "../balebase";
import {
  initialRunDetail,
  type RunDetail,
  runDetailTransition,
} from "./runDetailState";

/** How long a queued or running job waits between reads of its output. */
export const runPollMs = 5_000;

/**
 * A run's details at `before` (empty for the latest logs), read again every
 * `runPollMs` while the latest page shows the run queued or running. The
 * states and their transitions are in `runDetailState.ts`.
 */
function useRunDetail(runId: string, before: string) {
  const [state, dispatch] = useReducer(runDetailTransition, initialRunDetail);
  const [attempt, setAttempt] = useState(0);
  // Tags every request: only the current one can finish the details, so a
  // read for a page the admin left, or one a retry replaced, changes nothing.
  const requests = useRef(0);
  const shown = useRef({ runId, before });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry restarts the request even when its run and cursor are unchanged.
  useEffect(() => {
    const request = ++requests.current;
    const opened =
      shown.current.runId !== runId || shown.current.before !== before;
    shown.current = { runId, before };
    dispatch({ type: opened ? "opened" : "retried", request });
    // Leaving the run or its page ends the read in flight, which can take up
    // to the endpoint's 30-second timeout, and drops anything it returns.
    const leaving = new AbortController();
    const { signal } = leaving;
    const api = balebase().api.withSignal(signal);
    // Whether this request's latest read showed the run still in progress.
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    function load() {
      return api.adminJobs
        .detail(runId, before || undefined)
        .then((detail) => {
          if (signal.aborted) return;
          polling =
            detail.run.status === "queued" || detail.run.status === "running";
          dispatch({ type: "read", request, detail });
        })
        .catch((cause: unknown) => {
          if (signal.aborted) return;
          dispatch({
            type: "readFailed",
            request,
            error:
              cause instanceof Error && cause.name === "TimeoutError"
                ? "Loading job output took too long. Try again."
                : errorMessage(cause, "Could not load job output."),
          });
        })
        .finally(() => {
          if (!signal.aborted && !before && polling)
            timer = setTimeout(() => void load(), runPollMs);
        });
    }
    void load();
    return () => {
      leaving.abort();
      clearTimeout(timer);
    };
  }, [runId, before, attempt]);
  return {
    detail: state.status === "loaded" ? state.detail : undefined,
    error: state.status === "loading" ? undefined : state.error,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function AdminJobRun({ runId }: { runId: string }) {
  const [before, setBefore] = useState("");
  const { detail, error, retry } = useRunDetail(runId, before);
  const run = detail?.run;
  return (
    <div className="adminJobRunDetails">
      <h3>Run details</h3>
      {error && (
        <Toast
          tone="danger"
          actions={<Button onClick={retry}>Retry loading output</Button>}
        >
          {error}
        </Toast>
      )}
      {!detail && !error && <LoadingState label="Loading job output…" />}
      {run && (
        <div className="stack stackMd">
          <p>
            <strong>{run.status}</strong> · {run.attempts} processing attempt(s)
            · {run.source}
          </p>
          {run.dryRun && (
            <Banner tone="info">
              Dry run: the output counts what the job would change. Nothing was
              changed.
            </Banner>
          )}
          <p className="textSm">Run ID: {run.runId}</p>
          <p className="textSm">Requested by: {requester(run)}</p>
          {run.connectionId && (
            <p className="textSm">Bank connection: {run.connectionId}</p>
          )}
          <p className="textSm">
            Created: {new Date(run.createdAt).toLocaleString()}
            <br />
            Started:{" "}
            {run.startedAt
              ? new Date(run.startedAt).toLocaleString()
              : "Not recorded"}
            <br />
            Finished:{" "}
            {run.finishedAt
              ? new Date(run.finishedAt).toLocaleString()
              : "Pending"}
            {run.durationMs !== null && <> · {run.durationMs} ms</>}
          </p>
          {run.status === "queued" && (
            <p>
              Waiting to run. Available after{" "}
              {new Date(run.availableAt).toLocaleString()}.
            </p>
          )}
          {run.error && (
            <Banner tone="danger">
              {run.errorCode}: {run.error}
            </Banner>
          )}
          <div>
            <strong>Saved output</strong>
            {run.output ? (
              <pre>{JSON.stringify(run.output, null, 2)}</pre>
            ) : (
              <p>No output has been saved.</p>
            )}
          </div>
          <div>
            <strong>Logs</strong>
            <ol>
              {detail?.logs.map((log) => (
                <li key={log.id}>
                  <p>
                    {new Date(log.occurredAt).toLocaleString()} · {log.level} ·{" "}
                    {log.message}
                  </p>
                  <pre>{JSON.stringify(log.details, null, 2)}</pre>
                </li>
              ))}
            </ol>
          </div>
          <div className="cluster">
            {before && (
              <Button onClick={() => setBefore("")}>Latest logs</Button>
            )}
            {detail?.nextBefore && (
              <Button onClick={() => setBefore(detail.nextBefore ?? "")}>
                Earlier logs
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function requester(run: RunDetail["run"]) {
  if (run.requestedByName)
    return `${run.requestedByName} (${run.requestedByEmail ?? "no email"})`;
  // Runs requested before names were saved keep only the account ID.
  return run.requestedBy ?? "Scheduler";
}
