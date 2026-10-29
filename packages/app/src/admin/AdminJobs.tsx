import {
  Button,
  confirmDialog,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { useCallback, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { useLoad } from "../shared/useLoad";
import { AdminJobHistory } from "./AdminJobHistory";

export function AdminJobs() {
  const loaded = useLoad(
    useCallback(() => api.adminJobs.list(), []),
    "Could not load jobs.",
  );
  const jobs = loaded.data;
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const error = failure ?? loaded.error;
  const [startedRun, setStartedRun] = useState<{
    run: JobRun;
    request: number;
  }>();

  async function trigger(job: JobDefinition) {
    if (!(await confirmJobRun(job))) return;
    setBusy(job.id);
    setFailure(undefined);
    try {
      const run = await api.adminJobs.run(job.id);
      setStartedRun((previous) => ({
        run,
        request: (previous?.request ?? 0) + 1,
      }));
    } catch (cause) {
      setFailure(
        `${errorMessage(cause, "Could not start the job.")} Check recent runs before trying again.`,
      );
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Root Admin"
        title="Jobs"
        description="Run maintenance and inspect background jobs, logs, and saved output."
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        <PageSection title="Available jobs">
          <p className="textSm textSubtle">
            Maintenance applies across the platform. Jobs continue after you
            close this page. Completed runs and their logs are kept for 30 days.
            Schedules show when jobs are queued; actual start times depend on
            queue availability and any preceding jobs.
          </p>
          {!jobs && !error && <LoadingState label="Loading jobs…" />}
          <div className="stack stackMd">
            {jobs?.map((job) => (
              <div className="adminJobRow" key={job.id}>
                <div className="adminJobSummary">
                  <strong>{job.name}</strong>
                  <p className="textSm textSubtle">{job.description}</p>
                  <p className="textSm">
                    <strong>Run schedule:</strong>{" "}
                    {job.runSchedule ?? "Schedule unavailable."}
                  </p>
                </div>
                {job.manual && (
                  <Button
                    busy={busy === job.id}
                    disabled={busy !== undefined}
                    onClick={() => void trigger(job)}
                  >
                    Run now
                  </Button>
                )}
              </div>
            ))}
          </div>
        </PageSection>
        <AdminJobHistory
          key={startedRun?.request ?? 0}
          jobs={jobs ?? []}
          initialRun={startedRun?.run}
        />
      </PageBody>
    </Page>
  );
}

function confirmJobRun(job: JobDefinition) {
  return confirmDialog({
    confirmLabel: "Run job",
    message: `${job.description}\n\nThis affects all eligible organizations. Existing retention periods still apply. An active run of this job will be reused.`,
    title: `Run ${job.name}?`,
  });
}
