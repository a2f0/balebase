import {
  Banner,
  Button,
  confirmDialog,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  MaintenanceJob,
  MaintenanceRun,
} from "@balebase/validators/adminJobs";
import { useEffect, useState } from "react";
import { api } from "./apiClient";

export function AdminJobs() {
  const [jobs, setJobs] = useState<MaintenanceJob[]>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [run, setRun] = useState<MaintenanceRun>();
  useEffect(() => {
    void api.adminJobs
      .list()
      .then(setJobs)
      .catch((cause: unknown) => {
        setError(messageFrom(cause));
      });
  }, []);

  async function trigger(job: MaintenanceJob) {
    if (!(await confirmJobRun(job))) return;
    setBusy(job.id);
    setError(undefined);
    setRun(undefined);
    try {
      setRun(await api.adminJobs.run(job.id));
    } catch (cause) {
      setError(
        `${messageFrom(cause)} The outcome may be unknown; check Workers Logs before retrying.`,
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
        description="Run platform maintenance on demand using the same rules as scheduled jobs."
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {run && <RunResult run={run} />}
        <PageSection title="Maintenance jobs">
          <p className="textSm textSubtle">
            Runs apply across the platform. Keep this page open until the result
            appears. Run details are recorded in Cloudflare Workers Logs.
          </p>
          {!jobs && !error && <LoadingState label="Loading jobs…" />}
          <div className="stack stackMd">
            {jobs?.map((job) => (
              <div className="cluster clusterBetween" key={job.id}>
                <div>
                  <strong>{job.name}</strong>
                  <p className="textSm textSubtle">{job.description}</p>
                </div>
                <Button
                  busy={busy === job.id}
                  disabled={busy !== undefined}
                  onClick={() => void trigger(job)}
                >
                  Run now
                </Button>
              </div>
            ))}
          </div>
        </PageSection>
      </PageBody>
    </Page>
  );
}

function RunResult({ run }: { run: MaintenanceRun }) {
  return (
    <Banner tone={run.status === "failed" ? "danger" : "success"}>
      <p>{run.status === "failed" ? run.error : "Job completed."}</p>
      {run.result != null && <p>Result: {JSON.stringify(run.result)}</p>}
      <p>
        Run ID: {run.runId} · {run.durationMs} ms
      </p>
    </Banner>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not complete the request.";
}

function confirmJobRun(job: MaintenanceJob) {
  return confirmDialog({
    confirmLabel: "Run job",
    message: `${job.description}\n\nThis affects all eligible organizations. Existing retention periods still apply.`,
    title: `Run ${job.name}?`,
  });
}
