import { Banner, Button } from "@balebase/ui/react";
import { useDevice } from "../offline/offlineContext";
import { retryOfflineWork } from "../offline/offlineWork";
import { errorMessage } from "../shared/errors";
import { countLabel } from "../shared/labels";

/**
 * One line about this device's work: whether it is online, how much is
 * waiting to sync, and why anything is held back, with a retry.
 */
export function DeviceSyncStatus() {
  const { error, online, workspace } = useDevice();
  if (!workspace) return error ? <Banner tone="danger">{error}</Banner> : null;
  const waiting = workspace.jobs.filter((job) => job.status !== "synced");
  const problems = [
    ...new Set(waiting.flatMap((job) => (job.error ? [job.error] : []))),
  ];
  // Answers given to a shared audit wait here until the next sync sends them.
  const unsent = workspace.audits.filter(
    (audit) => audit.status !== "draft" && Object.keys(audit.local).length > 0,
  ).length;
  const open = workspace.audits.filter(
    (audit) => audit.status !== "completed",
  ).length;
  const parts = [
    online ? "Online" : "Offline",
    waiting.length + unsent
      ? `${countLabel(waiting.length + unsent, "item")} waiting to sync`
      : "Nothing waiting to sync",
    ...(open
      ? [`${countLabel(open, "audit")} in progress on this device`]
      : []),
  ];
  return (
    <Banner
      actions={
        waiting.length > 0 && (
          <Button
            onClick={() =>
              void retryOfflineWork(workspace.key).catch((cause: unknown) =>
                console.warn(errorMessage(cause, "Could not retry sync.")),
              )
            }
            size="sm"
          >
            Retry sync
          </Button>
        )
      }
      announce={false}
      icon={online ? "refresh" : "alert"}
      tone={problems.length || error ? "danger" : "neutral"}
    >
      <span role="status">{parts.join(" · ")}.</span>
      {[error, ...problems].filter(Boolean).map((problem) => (
        <span className="textSm" key={problem}>
          {" "}
          {problem}
        </span>
      ))}
    </Banner>
  );
}
