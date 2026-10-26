import {
  Button,
  Field,
  LoadingState,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { useEffect, useState } from "react";
import { AdminJobHistoryRow } from "./AdminJobHistoryRow";
import { api } from "./apiClient";

type History = Awaited<ReturnType<typeof api.adminJobs.runs>>;
type Props = {
  jobs: JobDefinition[];
  initialRun: JobRun | undefined;
};

function useJobHistory(
  jobId: string,
  status: JobRun["status"] | "",
  cursor: string,
) {
  const [data, setData] = useState<History>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    const query = {
      ...(jobId ? { jobId } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    };
    function load() {
      return api.adminJobs
        .runs(query)
        .then((result) => {
          if (!active) return;
          setData(result);
          setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load job history.",
          );
        })
        .finally(() => {
          if (active) timer = setTimeout(() => void load(), 5000);
        });
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, status, cursor]);
  return { data, error };
}

export function AdminJobHistory({ jobs, initialRun }: Props) {
  const [selectedRun, setSelectedRun] = useState(initialRun?.runId);
  const [pendingRun, setPendingRun] = useState(initialRun);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState<JobRun["status"] | "">("");
  const [cursor, setCursor] = useState("");
  const { data, error } = useJobHistory(jobId, status, cursor);
  useEffect(() => {
    if (data?.runs.some((run) => run.runId === pendingRun?.runId))
      setPendingRun(undefined);
  }, [data, pendingRun]);
  const runs = data?.runs ?? [];
  // A newly requested run is visible immediately, even before history refreshes.
  const visibleRuns =
    pendingRun &&
    !jobId &&
    !status &&
    !cursor &&
    !runs.some((run) => run.runId === pendingRun.runId)
      ? [pendingRun, ...runs]
      : runs;
  return (
    <PageSection title="Run history">
      <div className="cluster">
        <Field label="Job">
          <Select
            value={jobId}
            onChange={(event) => {
              setJobId(event.target.value);
              setCursor("");
              setSelectedRun(undefined);
            }}
          >
            <option value="">All jobs</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as JobRun["status"] | "");
              setCursor("");
              setSelectedRun(undefined);
            }}
          >
            <option value="">All statuses</option>
            {["queued", "running", "succeeded", "failed", "cancelled"].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </Select>
        </Field>
      </div>
      {error && <Toast tone="danger">{error}</Toast>}
      {!data && !error && <LoadingState label="Loading run history…" />}
      {data && visibleRuns.length === 0 && <p>No runs match these filters.</p>}
      <div className="stack stackMd">
        {visibleRuns.map((run) => (
          <AdminJobHistoryRow
            key={run.runId}
            run={run}
            name={jobs.find((job) => job.id === run.jobId)?.name ?? run.jobId}
            expanded={selectedRun === run.runId}
            onToggle={() =>
              setSelectedRun(selectedRun === run.runId ? undefined : run.runId)
            }
          />
        ))}
      </div>
      <div className="cluster">
        {cursor && (
          <Button
            onClick={() => {
              setCursor("");
              setSelectedRun(undefined);
            }}
          >
            Latest runs
          </Button>
        )}
        {data?.nextCursor && (
          <Button
            onClick={() => {
              setCursor(data.nextCursor ?? "");
              setSelectedRun(undefined);
            }}
          >
            Older runs
          </Button>
        )}
      </div>
    </PageSection>
  );
}
