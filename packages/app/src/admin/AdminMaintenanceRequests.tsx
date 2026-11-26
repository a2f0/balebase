import {
  Badge,
  EmptyState,
  LoadingState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  JobDefinition,
  MaintenanceRequest,
} from "@balebase/validators/adminJobs";
import { useCallback } from "react";
import { balebase } from "../balebase";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { formatDateTime } from "../shared/labels";
import { useCursorPages } from "../shared/useCursorPages";
import { AdminIdentity } from "./AdminIdentity";

/**
 * Every manual maintenance request, newest first, including ones that joined
 * a run already in progress. Requests outlive the 30-day run history and the
 * requester's account.
 */
export function AdminMaintenanceRequests({
  jobId,
  jobs,
}: {
  /** Shows only this job's requests. */
  jobId?: string | undefined;
  jobs: JobDefinition[];
}) {
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await balebase().api.adminJobs.requests({
        ...(jobId ? { jobId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return { items: page.requests, nextCursor: page.nextCursor };
    },
    [jobId],
  );
  const requests = useCursorPages(
    fetchPage,
    "Could not load maintenance requests.",
  );
  return (
    <PageSection
      description="Who asked for each manual run. Requests are kept after their runs leave the history."
      title="Manual requests"
    >
      {requests.error && <Toast tone="danger">{requests.error}</Toast>}
      {requests.items?.length ? (
        <ul className="rowList">
          {requests.items.map((request) => (
            <RequestRow
              jobName={
                jobs.find(({ id }) => id === request.jobId)?.name ??
                request.jobId
              }
              key={request.id}
              request={request}
            />
          ))}
        </ul>
      ) : requests.items ? (
        <EmptyState compact icon="list" title="No manual requests">
          Jobs started with Run now or Dry run appear here.
        </EmptyState>
      ) : (
        !requests.error && <LoadingState label="Loading requests…" />
      )}
      {requests.items && requests.nextCursor && (
        <InfiniteScroll
          autoLoad={!requests.error}
          busy={requests.loadingMore}
          cursor={requests.nextCursor}
          disabled={requests.refreshing}
          key={requests.generation}
          onLoadMore={requests.loadMore}
        >
          Load more requests
        </InfiniteScroll>
      )}
    </PageSection>
  );
}

function RequestRow({
  jobName,
  request,
}: {
  jobName: string;
  request: MaintenanceRequest;
}) {
  return (
    <li className="row">
      <span className="rowMain">
        <span className="rowTitle">{jobName}</span>
        <span className="rowMeta">
          {formatDateTime(request.requestedAt)} · Run {request.runId}
        </span>
      </span>
      <span className="rowActions">
        <AdminIdentity detail={request.actor.email} name={request.actor.name} />
        {request.dryRun && <Badge tone="info">Dry run</Badge>}
        {request.joinedActiveRun && (
          <Badge tone="neutral">Joined a run in progress</Badge>
        )}
      </span>
    </li>
  );
}
