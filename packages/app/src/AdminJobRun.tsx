import { Banner, Button, LoadingState, Toast } from "@balebase/ui/react";
import { useEffect, useRef, useState } from "react";
import { api } from "./apiClient";
import { errorMessage } from "./errors";

type Detail = Awaited<ReturnType<typeof api.adminJobs.detail>>;

/** How long a queued or running job waits between reads of its output. */
export const runPollMs = 5_000;

function useRunDetail(runId: string, before: string) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const previous = useRef({ runId, before });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry restarts the request even when its run and cursor are unchanged.
  useEffect(() => {
    if (previous.current.runId !== runId || previous.current.before !== before)
      setDetail(undefined);
    previous.current = { runId, before };
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    setError(undefined);
    function load() {
      return api.adminJobs
        .detail(runId, before || undefined)
        .then((result) => {
          if (!active) return;
          polling =
            result.run.status === "queued" || result.run.status === "running";
          setDetail(result);
          setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(
            cause instanceof Error && cause.name === "TimeoutError"
              ? "Loading job output took too long. Try again."
              : errorMessage(cause, "Could not load job output."),
          );
        })
        .finally(() => {
          if (active && !before && polling)
            timer = setTimeout(() => void load(), runPollMs);
        });
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, before, attempt]);
  return { detail, error, retry: () => setAttempt((value) => value + 1) };
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
          <p className="textSm">Run ID: {run.runId}</p>
          <p className="textSm">
            Requested by: {run.requestedBy ?? "Scheduler"}
          </p>
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
