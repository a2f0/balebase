import {
  Button,
  confirmDialog,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { useLoad } from "../shared/useLoad";
import { AdminJobHistory } from "./AdminJobHistory";
import { AdminMaintenanceRequests } from "./AdminMaintenanceRequests";

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
  const sections = useSectionTabs([
    { id: "jobs", label: "Available jobs" },
    { id: "history", label: "Run history" },
    { id: "requests", label: "Manual requests" },
    { id: "purges", label: "Purge history" },
  ]);

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
      // The new run opens in the history.
      sections.select("history");
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
        tabs={sections.tabs}
        tabsKind="panels"
        tabsLabel="Job sections"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {sections.panel(
          "jobs",
          <AvailableJobs
            busy={busy}
            failed={Boolean(error)}
            jobs={jobs}
            onRun={trigger}
          />,
        )}
        {sections.panel(
          "history",
          <AdminJobHistory
            key={startedRun?.request ?? 0}
            jobs={jobs ?? []}
            initialRun={startedRun?.run}
          />,
        )}
        {sections.panel(
          "requests",
          <AdminMaintenanceRequests
            jobs={jobs ?? []}
            key={`requests-${startedRun?.request ?? 0}`}
          />,
        )}
        {sections.panel(
          "purges",
          <ActivityFeed
            source={{ id: "platform", type: "admin_purges" }}
            title="Purge history"
          />,
        )}
      </PageBody>
    </Page>
  );
}

function AvailableJobs({
  busy,
  failed,
  jobs,
  onRun,
}: {
  busy: string | undefined;
  failed: boolean;
  jobs: JobDefinition[] | undefined;
  onRun: (job: JobDefinition) => Promise<void>;
}) {
  return (
    <PageSection title="Available jobs">
      <p className="textSm textSubtle">
        Maintenance applies across the platform. Jobs continue after you close
        this page. Completed runs and their logs are kept for 30 days. Schedules
        show when jobs are queued; actual start times depend on queue
        availability and any preceding jobs.
      </p>
      {!jobs && !failed && <LoadingState label="Loading jobs…" />}
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
                onClick={() => void onRun(job)}
              >
                Run now
              </Button>
            )}
          </div>
        ))}
      </div>
    </PageSection>
  );
}

function confirmJobRun(job: JobDefinition) {
  return confirmDialog({
    confirmLabel: "Run job",
    message: `${job.description}\n\nThis affects all eligible organizations. Existing retention periods still apply. An active run of this job will be reused.`,
    title: `Run ${job.name}?`,
  });
}
