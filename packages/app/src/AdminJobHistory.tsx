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
import { AdminJobRun } from "./AdminJobRun";
import { api } from "./apiClient";

type History = Awaited<ReturnType<typeof api.adminJobs.runs>>;
type Props = {
  jobs: JobDefinition[];
  selectedRun: string | undefined;
  onSelect: (id: string) => void;
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

export function AdminJobHistory({ jobs, selectedRun, onSelect }: Props) {
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState<JobRun["status"] | "">("");
  const [cursor, setCursor] = useState("");
  const { data, error } = useJobHistory(jobId, status, cursor);
  return (
    <>
      <PageSection title="Run history">
        <div className="cluster">
          <Field label="Job">
            <Select
              value={jobId}
              onChange={(event) => {
                setJobId(event.target.value);
                setCursor("");
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
        {data?.runs.length === 0 && <p>No runs match these filters.</p>}
        <div className="stack stackMd">
          {data?.runs.map((run) => (
            <div className="cluster clusterBetween" key={run.runId}>
              <div>
                <strong>
                  {jobs.find((job) => job.id === run.jobId)?.name ?? run.jobId}
                </strong>
                <p className="textSm textSubtle">
                  {run.status} · {run.source} ·{" "}
                  {new Date(run.createdAt).toLocaleString()}
                </p>
                {run.organizationId && (
                  <p className="textSm">Organization: {run.organizationId}</p>
                )}
              </div>
              <Button
                aria-pressed={selectedRun === run.runId}
                onClick={() => onSelect(run.runId)}
              >
                View run
              </Button>
            </div>
          ))}
        </div>
        <div className="cluster">
          {cursor && <Button onClick={() => setCursor("")}>Latest runs</Button>}
          {data?.nextCursor && (
            <Button onClick={() => setCursor(data.nextCursor ?? "")}>
              Older runs
            </Button>
          )}
        </div>
      </PageSection>
      {selectedRun && <AdminJobRun key={selectedRun} runId={selectedRun} />}
    </>
  );
}
