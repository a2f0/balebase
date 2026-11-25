import { confirmDialog, promptDialog } from "@balebase/ui/react";
import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { cronProblem, describeCron } from "@balebase/validators/cron";
import { useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { useAction } from "../shared/useAction";

/**
 * A maintenance job's actions, for its row menu and its own page: run it,
 * dry-run it, and edit, pause, or resume its schedule. One runs at a time;
 * `jobId` is the job it is for.
 */
export function useJobActions({
  onJobChanged,
  onRunStarted,
}: {
  /** The job as the API returned it after its schedule changed. */
  onJobChanged: (job: JobDefinition) => void;
  onRunStarted: (run: JobRun) => void;
}) {
  const [jobId, setJobId] = useState<string>();
  const action = useAction("Could not update the job.");

  async function act(job: JobDefinition, work: () => Promise<unknown>) {
    setJobId(job.id);
    await action.run(work);
    setJobId(undefined);
  }

  async function run(job: JobDefinition, dryRun = false) {
    if (!(await (dryRun ? confirmDryRun(job) : confirmJobRun(job)))) return;
    setJobId(job.id);
    const started = await action.run(async () => {
      try {
        onRunStarted(await api.adminJobs.run(job.id, { dryRun }));
      } catch (cause) {
        const fallback = `Could not start the ${dryRun ? "dry run" : "job"}.`;
        throw new Error(
          `${errorMessage(cause, fallback)} Check recent runs before trying again.`,
        );
      }
    });
    setJobId(undefined);
    return started;
  }

  async function editSchedule(job: JobDefinition) {
    const answer = await promptDialog({
      title: `Edit the schedule for ${job.name}`,
      message: scheduleHelp(job),
      label: "Cron schedule (UTC)",
      defaultValue: job.schedule?.cron ?? "17 * * * *",
      placeholder: "17 * * * *",
      maxLength: 100,
      required: true,
      confirmLabel: "Save schedule",
    });
    if (answer === null) return;
    const problem = cronProblem(answer);
    if (problem) {
      action.setError(problem);
      return;
    }
    await act(job, async () =>
      onJobChanged(
        await api.adminJobs.saveSchedule(job.id, {
          cron: answer,
          enabled: job.schedule?.enabled ?? true,
        }),
      ),
    );
  }

  async function setScheduleEnabled(job: JobDefinition, enabled: boolean) {
    const schedule = job.schedule;
    if (!schedule) return;
    const confirmed = await confirmDialog(
      enabled
        ? {
            title: `Resume the schedule for ${job.name}?`,
            message: `${describeCron(schedule.cron)}. ${job.description}`,
            confirmLabel: "Resume schedule",
          }
        : {
            title: `Pause the schedule for ${job.name}?`,
            message:
              "The job runs only when someone runs it from here until its schedule is resumed. Queued and running runs continue.",
            confirmLabel: "Pause schedule",
          },
    );
    if (!confirmed) return;
    await act(job, async () =>
      onJobChanged(
        await api.adminJobs.saveSchedule(job.id, {
          cron: schedule.cron,
          enabled,
        }),
      ),
    );
  }

  return {
    editSchedule,
    error: action.error,
    jobId,
    run,
    setError: action.setError,
    setScheduleEnabled,
  };
}

function scheduleHelp(job: JobDefinition) {
  const current = job.schedule
    ? `Now: ${describeCron(job.schedule.cron)}${job.schedule.enabled ? "" : " (paused)"}.`
    : "This job has no schedule yet; it runs only on request.";
  const paused =
    job.schedule && !job.schedule.enabled
      ? "\nThe schedule stays paused until you resume it."
      : "";
  return `${current}\n\nFive fields in UTC: minute, hour, day of month, month, and day of week. For example, 17 * * * * runs at 17 past every hour, 0 3 * * * daily at 03:00, and 0 9 * * MON on Mondays at 09:00.${paused}`;
}

function confirmJobRun(job: JobDefinition) {
  return confirmDialog({
    confirmLabel: "Run job",
    message: `${job.description}\n\nThis affects all eligible organizations. Existing retention periods still apply. An active run of this job will be reused.`,
    title: `Run ${job.name}?`,
  });
}

function confirmDryRun(job: JobDefinition) {
  return confirmDialog({
    confirmLabel: "Start dry run",
    message: `Counts what ${job.name} would change now, within its batch limits, and changes nothing: no records are deleted, no email is sent, and no provider is called. An active dry run of this job will be reused.`,
    title: `Dry run ${job.name}?`,
  });
}
