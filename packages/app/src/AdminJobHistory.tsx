import {
  Field,
  LoadingState,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { useEffect, useState } from "react";
import { AdminJobHistoryRow } from "./AdminJobHistoryRow";
import { InfiniteScroll } from "./shared/InfiniteScroll";
import { useJobHistory } from "./useJobHistory";

type Props = {
  jobs: JobDefinition[];
  initialRun: JobRun | undefined;
};

export function AdminJobHistory({ jobs, initialRun }: Props) {
  const [selectedRun, setSelectedRun] = useState(initialRun?.runId);
  const [pendingRun, setPendingRun] = useState(initialRun);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState<JobRun["status"] | "">("");
  const { data, error, loadMoreError, loadingMore, refreshing, loadMore } =
    useJobHistory(jobId, status);
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
      {loadMoreError && <Toast tone="danger">{loadMoreError}</Toast>}
      {data?.nextCursor && (
        <InfiniteScroll
          autoLoad={!error && !loadMoreError}
          cursor={data.nextCursor}
          busy={loadingMore}
          disabled={refreshing}
          onLoadMore={loadMore}
        >
          {loadMoreError ? "Retry loading older runs" : "Older runs"}
        </InfiniteScroll>
      )}
    </PageSection>
  );
}
