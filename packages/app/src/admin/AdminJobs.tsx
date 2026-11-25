import {
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import { useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { adminJobIdForPath } from "../workspace/workspacePaths";
import { AdminJobDetail } from "./AdminJobDetail";
import { AdminJobHistory } from "./AdminJobHistory";
import { AdminJobRow } from "./AdminJobRow";
import { AdminMaintenanceRequests } from "./AdminMaintenanceRequests";
import { useJobActions } from "./useJobActions";
import { type StartedRun, useJobCatalog } from "./useJobCatalog";

/** Every background job, or one job's schedule and history. */
export function AdminJobs({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const jobId = adminJobIdForPath(pathname);
  return jobId ? (
    <AdminJobDetail jobId={jobId} key={jobId} onNavigate={onNavigate} />
  ) : (
    <AdminJobList onNavigate={onNavigate} />
  );
}

function AdminJobList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const catalog = useJobCatalog();
  const jobs = catalog.data;
  const [startedRun, setStartedRun] = useState<StartedRun>();
  const sections = useSectionTabs([
    { id: "jobs", label: "Available jobs" },
    { id: "history", label: "Run history" },
    { id: "requests", label: "Manual requests" },
    { id: "purges", label: "Purge history" },
  ]);
  const actions = useJobActions({
    onJobChanged: catalog.replaceJob,
    onRunStarted: (run) => {
      setStartedRun((previous) => ({
        run,
        request: (previous?.request ?? 0) + 1,
      }));
      // The new run opens in the history.
      sections.select("history");
    },
  });
  const error = actions.error ?? catalog.error;

  return (
    <Page>
      <PageHeader
        eyebrow="Root Admin"
        title="Jobs"
        description="Run, dry-run, and schedule maintenance, and inspect background jobs, logs, and saved output."
        tabs={sections.tabs}
        tabsKind="panels"
        tabsLabel="Job sections"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {sections.panel(
          "jobs",
          <PageSection title="Available jobs">
            <p className="textSm textSubtle">
              Maintenance applies across the platform. Jobs continue after you
              close this page. Completed runs and their logs are kept for 30
              days. Schedules show when jobs are queued; actual start times
              depend on queue availability and any preceding jobs. A dry run
              reports what a job would change without changing anything.
            </p>
            {!jobs && !catalog.error && <LoadingState label="Loading jobs…" />}
            <div className="stack stackMd">
              {jobs?.map((job) => (
                <AdminJobRow
                  actions={actions}
                  job={job}
                  key={job.id}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </PageSection>,
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
