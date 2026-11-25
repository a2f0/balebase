import {
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type { JobDefinition } from "@balebase/validators/adminJobs";
import { useState } from "react";
import { formatDateTime } from "../shared/labels";
import { adminJobPath } from "../workspace/workspacePaths";
import { AdminIdentity } from "./AdminIdentity";
import { AdminJobHistory } from "./AdminJobHistory";
import { AdminJobScheduleChanges } from "./AdminJobScheduleChanges";
import { AdminMaintenanceRequests } from "./AdminMaintenanceRequests";
import { useJobActions } from "./useJobActions";
import { type StartedRun, useJobCatalog } from "./useJobCatalog";

/**
 * One job's page: its schedule and actions, and only its own runs, schedule
 * changes, and manual requests.
 */
export function AdminJobDetail({
  jobId,
  onNavigate,
}: {
  jobId: string;
  onNavigate: (pathname: string) => void;
}) {
  const catalog = useJobCatalog();
  const job = catalog.data?.find(({ id }) => id === jobId);
  const [startedRun, setStartedRun] = useState<StartedRun>();
  const sections = useSectionTabs([
    { id: "history", label: "Run history" },
    job?.manual && { id: "schedule", label: "Schedule changes" },
    job?.manual && { id: "requests", label: "Manual requests" },
  ]);
  const actions = useJobActions({
    onJobChanged: catalog.replaceJob,
    onRunStarted: (run) => {
      setStartedRun((previous) => ({
        run,
        request: (previous?.request ?? 0) + 1,
      }));
      // The new run opens in this job's history.
      sections.select("history");
    },
  });
  const busy = actions.jobId !== undefined;
  const error = actions.error ?? catalog.error;
  return (
    <Page>
      <PageHeader
        actions={
          job?.manual && (
            <div className="cluster">
              <Button
                disabled={busy}
                icon="eye"
                onClick={() => void actions.run(job, true)}
              >
                Dry run
              </Button>
              <Button
                disabled={busy}
                icon="refresh"
                onClick={() => void actions.run(job)}
              >
                Run now
              </Button>
            </div>
          )
        }
        back={
          <Button
            icon="arrowLeft"
            onClick={() => onNavigate(adminJobPath())}
            size="sm"
            variant="ghost"
          >
            Jobs
          </Button>
        }
        description={job?.description}
        eyebrow="Root Admin"
        tabs={job ? sections.tabs : undefined}
        tabsKind="panels"
        tabsLabel="Job sections"
        title={job?.name ?? "Job"}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {!catalog.data && !catalog.error && (
          <LoadingState label="Loading job…" />
        )}
        {catalog.data && !job && (
          <EmptyState compact icon="list" title="Job not found">
            There is no job with this ID.
          </EmptyState>
        )}
        {job && (
          <>
            <JobSchedule actions={actions} job={job} />
            {sections.panel(
              "history",
              <AdminJobHistory
                fixedJobId={job.id}
                initialRun={startedRun?.run}
                jobs={catalog.data ?? []}
                key={startedRun?.request ?? 0}
              />,
            )}
            {sections.panel(
              "schedule",
              <AdminJobScheduleChanges
                jobId={job.id}
                key={job.schedule?.updatedAt ?? ""}
              />,
            )}
            {sections.panel(
              "requests",
              <AdminMaintenanceRequests
                jobId={job.id}
                jobs={catalog.data ?? []}
                key={startedRun?.request ?? 0}
              />,
            )}
          </>
        )}
      </PageBody>
    </Page>
  );
}

/** The job's schedule, when it next runs, who last changed it, and its actions. */
function JobSchedule({
  actions,
  job,
}: {
  actions: ReturnType<typeof useJobActions>;
  job: JobDefinition;
}) {
  const schedule = job.schedule;
  const busy = actions.jobId !== undefined;
  return (
    <PageSection
      actions={
        job.manual && (
          <div className="cluster">
            <Button
              disabled={busy}
              icon="calendar"
              onClick={() => void actions.editSchedule(job)}
              size="sm"
            >
              Edit schedule
            </Button>
            {schedule && (
              <Button
                disabled={busy}
                icon={schedule.enabled ? "void" : "check"}
                onClick={() =>
                  void actions.setScheduleEnabled(job, !schedule.enabled)
                }
                size="sm"
              >
                {schedule.enabled ? "Pause schedule" : "Resume schedule"}
              </Button>
            )}
          </div>
        )
      }
      title="Schedule"
    >
      <div className="stack stackSm">
        <p>
          {job.runSchedule}{" "}
          {schedule && !schedule.enabled && (
            <Badge tone="neutral">Paused</Badge>
          )}
        </p>
        {schedule && (
          <p className="textSm textSubtle">
            Cron (UTC): <span className="mono">{schedule.cron}</span>
            {schedule.nextRunAt &&
              ` · Next run ${formatDateTime(schedule.nextRunAt)}`}
          </p>
        )}
        {schedule?.updatedBy && schedule.updatedAt && (
          <div className="cluster textSm textSubtle">
            <span>Last changed {formatDateTime(schedule.updatedAt)} by</span>
            <AdminIdentity
              detail={schedule.updatedBy.email}
              name={schedule.updatedBy.name}
            />
          </div>
        )}
      </div>
    </PageSection>
  );
}
