import {
  Banner,
  Button,
  LoadingState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import { useEffect, useState } from "react";
import { api } from "./apiClient";

type Detail = Awaited<ReturnType<typeof api.adminJobs.detail>>;

function useRunDetail(runId: string, before: string) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let polling = true;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(undefined);
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
            cause instanceof Error
              ? cause.message
              : "Could not load job output.",
          );
        })
        .finally(() => {
          if (active && !before && polling)
            timer = setTimeout(() => void load(), 5000);
        });
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, before]);
  return { detail, error };
}

export function AdminJobRun({ runId }: { runId: string }) {
  const [before, setBefore] = useState("");
  const { detail, error } = useRunDetail(runId, before);
  const run = detail?.run;
  return (
    <PageSection title="Run details">
      {error && <Toast tone="danger">{error}</Toast>}
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
    </PageSection>
  );
}
