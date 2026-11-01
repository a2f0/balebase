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
} from "@balebase/ui/react";
import type { AdminUserHistoryEvent } from "@balebase/validators/adminUsers";
import { useCallback, useState } from "react";
import { formatRoles } from "../organizations/organizationState";
import { api } from "../shared/apiClient";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { formatDateTime } from "../shared/labels";
import { useCursorPages } from "../shared/useCursorPages";
import { adminUserPath } from "../workspace/workspacePaths";
import { AdminIdentity } from "./AdminIdentity";

const actionLabels: Record<AdminUserHistoryEvent["action"], string> = {
  admin_revoked: "Revoked root admin",
  deletion_canceled: "Canceled the account's deletion",
  deletion_requested: "Marked the account for deletion",
  role_set: "Set the platform role",
};

/**
 * One person's platform history for root admins: role changes, including
 * `auth:set-role` runs by operators, and account deletion requests and
 * cancellations, newest first, with who made each one as they were then.
 */
export function AdminUserHistory({
  onNavigate,
  userId,
}: {
  onNavigate: (pathname: string) => void;
  userId: string;
}) {
  const [user, setUser] = useState<{ email: string; name: string }>();
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await api.adminUsers.history(userId, cursor);
      setUser(page.user);
      return { items: page.events, nextCursor: page.nextCursor };
    },
    [userId],
  );
  const history = useCursorPages(fetchPage, "Could not load the history.");
  return (
    <Page>
      <PageHeader
        back={
          <Button
            icon="arrowLeft"
            onClick={() => onNavigate(adminUserPath())}
            size="sm"
            variant="ghost"
          >
            Users
          </Button>
        }
        description="Platform role changes and account deletion requests, newest first. The history is removed when the account is purged."
        eyebrow="Root Admin"
        title={user ? user.name || user.email : "User history"}
      />
      <PageBody>
        {history.error && <Toast tone="danger">{history.error}</Toast>}
        <PageSection title="History">
          {history.items?.length ? (
            <ul className="rowList">
              {history.items.map((event) => (
                <HistoryRow event={event} key={event.id} />
              ))}
            </ul>
          ) : history.items ? (
            <EmptyState compact icon="list" title="No platform history">
              Role changes and deletion requests for this account appear here.
            </EmptyState>
          ) : (
            !history.error && <LoadingState label="Loading history…" />
          )}
          {history.items && history.nextCursor && (
            <InfiniteScroll
              autoLoad={!history.error}
              busy={history.loadingMore}
              cursor={history.nextCursor}
              disabled={history.refreshing}
              key={history.generation}
              onLoadMore={history.loadMore}
            >
              Load more history
            </InfiniteScroll>
          )}
        </PageSection>
      </PageBody>
    </Page>
  );
}

function HistoryRow({ event }: { event: AdminUserHistoryEvent }) {
  const { actor } = event;
  return (
    <li className="row">
      <span className="rowMain">
        <span className="rowTitle">{actionLabels[event.action]}</span>
        <span className="rowMeta">
          {formatDateTime(event.occurredAt)}
          {event.newRole !== null &&
            ` · ${formatRoles(event.previousRole || "user")} → ${formatRoles(event.newRole)}`}
          {event.requestedAt !== null &&
            event.action === "deletion_canceled" &&
            ` · Requested ${formatDateTime(event.requestedAt)}`}
        </span>
      </span>
      <span className="rowActions">
        <AdminIdentity detail={actor.email || undefined} name={actor.name} />
        {actor.kind === "operator" && (
          <Badge tone="neutral">Operator (auth:set-role)</Badge>
        )}
      </span>
    </li>
  );
}
