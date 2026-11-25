import { ContextMenu, MenuButton } from "@balebase/ui/react";
import type { JobDefinition } from "@balebase/validators/adminJobs";
import { AppLink } from "../shared/AppLink";
import { formatDateTime } from "../shared/labels";
import { adminJobPath } from "../workspace/workspacePaths";
import type { useJobActions } from "./useJobActions";

type JobActions = ReturnType<typeof useJobActions>;

/** The actions a job's menu offers, in order. */
function jobMenuItems(
  job: JobDefinition,
  actions: JobActions,
  onViewHistory?: () => void,
) {
  const busy = actions.jobId !== undefined;
  const schedule = job.schedule;
  return [
    ...(job.manual
      ? [
          {
            disabled: busy,
            icon: "refresh" as const,
            id: "run",
            label: "Run now",
            onSelect: () => void actions.run(job),
          },
          {
            disabled: busy,
            icon: "eye" as const,
            id: "dry-run",
            label: "Dry run",
            onSelect: () => void actions.run(job, true),
          },
          {
            disabled: busy,
            icon: "calendar" as const,
            id: "edit-schedule",
            label: "Edit schedule",
            onSelect: () => void actions.editSchedule(job),
          },
        ]
      : []),
    ...(job.manual && schedule
      ? [
          schedule.enabled
            ? {
                disabled: busy,
                icon: "void" as const,
                id: "pause-schedule",
                label: "Pause schedule",
                onSelect: () => void actions.setScheduleEnabled(job, false),
              }
            : {
                disabled: busy,
                icon: "check" as const,
                id: "resume-schedule",
                label: "Resume schedule",
                onSelect: () => void actions.setScheduleEnabled(job, true),
              },
        ]
      : []),
    ...(onViewHistory
      ? [
          {
            icon: "list" as const,
            id: "history",
            label: "View history",
            onSelect: onViewHistory,
          },
        ]
      : []),
  ];
}

/**
 * One job in the jobs list. Its name opens the job's own page; its actions
 * open from the menu button or by right-clicking the row.
 */
export function AdminJobRow({
  actions,
  job,
  onNavigate,
}: {
  actions: JobActions;
  job: JobDefinition;
  onNavigate: (pathname: string) => void;
}) {
  const menuLabel = `Actions for ${job.name}`;
  const nextRunAt = job.schedule?.nextRunAt;
  return (
    // While any job action runs, its items are disabled but View history is not.
    <ContextMenu
      items={jobMenuItems(job, actions, () => onNavigate(adminJobPath(job.id)))}
      label={menuLabel}
    >
      {(row, menuButton) => (
        <div {...row} className="adminJobRow">
          <div className="adminJobSummary">
            <AppLink
              className="adminJobName"
              href={adminJobPath(job.id)}
              onNavigate={onNavigate}
            >
              {job.name}
            </AppLink>
            <p className="textSm textSubtle">{job.description}</p>
            <p className="textSm">
              <strong>Run schedule:</strong> {job.runSchedule}
            </p>
            {nextRunAt && (
              <p className="textSm textSubtle">
                Next run: {formatDateTime(nextRunAt)}
              </p>
            )}
          </div>
          <MenuButton
            {...menuButton}
            busy={actions.jobId === job.id}
            label={menuLabel}
          />
        </div>
      )}
    </ContextMenu>
  );
}
