import {
  EmptyState,
  LoadingState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { JobScheduleChange } from "@balebase/validators/adminJobs";
import { describeCron } from "@balebase/validators/cron";
import { useCallback } from "react";
import { balebase } from "../balebase";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { formatDateTime } from "../shared/labels";
import { useCursorPages } from "../shared/useCursorPages";
import { AdminIdentity } from "./AdminIdentity";

/**
 * Every change to a job's schedule, newest first, with the admin who made it
 * as they were then. Kept after the admin's account is purged.
 */
export function AdminJobScheduleChanges({ jobId }: { jobId: string }) {
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await balebase().api.adminJobs.scheduleChanges(
        jobId,
        cursor,
      );
      return { items: page.changes, nextCursor: page.nextCursor };
    },
    [jobId],
  );
  const changes = useCursorPages(fetchPage, "Could not load schedule changes.");
  return (
    <PageSection
      description="Who changed this job's schedule, and from what."
      title="Schedule changes"
    >
      {changes.error && <Toast tone="danger">{changes.error}</Toast>}
      {changes.items?.length ? (
        <ul className="rowList">
          {changes.items.map((change) => (
            <ChangeRow change={change} key={change.id} />
          ))}
        </ul>
      ) : changes.items ? (
        <EmptyState compact icon="calendar" title="No schedule changes">
          The job still has its default schedule.
        </EmptyState>
      ) : (
        !changes.error && <LoadingState label="Loading schedule changes…" />
      )}
      {changes.items && changes.nextCursor && (
        <InfiniteScroll
          autoLoad={!changes.error}
          busy={changes.loadingMore}
          cursor={changes.nextCursor}
          disabled={changes.refreshing}
          key={changes.generation}
          onLoadMore={changes.loadMore}
        >
          Load more changes
        </InfiniteScroll>
      )}
    </PageSection>
  );
}

/** What a change did, such as "Paused" or "Changed to Every day at 03:00 UTC". */
function scheduleChangeLabel(change: JobScheduleChange) {
  const cronChanged = change.previousCron !== change.cron;
  const enabledChanged = change.previousEnabled !== change.enabled;
  if (change.previousCron === null)
    return `Scheduled: ${describeCron(change.cron)}${change.enabled ? "" : " (paused)"}`;
  if (!cronChanged && enabledChanged)
    return change.enabled ? "Resumed" : "Paused";
  return `Changed to ${describeCron(change.cron)}${enabledChanged ? (change.enabled ? " and resumed" : " and paused") : ""}`;
}

function ChangeRow({ change }: { change: JobScheduleChange }) {
  return (
    <li className="row">
      <span className="rowMain">
        <span className="rowTitle">{scheduleChangeLabel(change)}</span>
        <span className="rowMeta">
          {formatDateTime(change.changedAt)}
          {change.previousCron !== null &&
            change.previousCron !== change.cron &&
            ` · Was ${change.previousCron}`}
          {` · Now ${change.cron}`}
        </span>
      </span>
      <span className="rowActions">
        <AdminIdentity detail={change.actor.email} name={change.actor.name} />
      </span>
    </li>
  );
}
