import type { IssueFilters } from "@balebase/api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
} from "@balebase/ui/react";
import { useCallback } from "react";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { formatLabel } from "../shared/labels";
import { useCursorPages } from "../shared/useCursorPages";
import { issuePath } from "../workspace/workspacePaths";

export function IssueList({
  filters,
  onNavigate,
}: {
  filters: IssueFilters;
  onNavigate: (path: string) => void;
}) {
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await api.issues.list(filters, cursor);
      return { items: page.issues, nextCursor: page.nextCursor };
    },
    [filters],
  );
  const { error, items, loadMore, loadingMore, nextCursor, reload } =
    useCursorPages(fetchPage, "Could not load issues.");
  return (
    <div className="stack">
      {error && (
        <Banner
          tone="danger"
          actions={
            <Button size="sm" onClick={reload}>
              Reload issues
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {!items && !error && <LoadingState label="Loading issues…" />}
      {items &&
        (items.length ? (
          <Card flush>
            <ul aria-label="Issues" className="rowList">
              {items.map((issue) => (
                <li className="row" key={issue.id}>
                  <div className="rowMain">
                    <AppLink
                      className="rowTitle"
                      href={issuePath(issue.id)}
                      onNavigate={onNavigate}
                    >
                      {issue.title}
                    </AppLink>
                    <span className="rowMeta">
                      {issue.target.label} ·{" "}
                      {issue.assignedTo?.name ||
                        issue.assignedTo?.email ||
                        "Unassigned"}
                    </span>
                  </div>
                  <div className="cluster">
                    <Badge
                      tone={
                        issue.priority === "critical" ||
                        issue.priority === "high"
                          ? "warning"
                          : "neutral"
                      }
                    >
                      {formatLabel(issue.priority)}
                    </Badge>
                    <Badge
                      tone={issue.status === "resolved" ? "success" : "neutral"}
                    >
                      {formatLabel(issue.status)}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState icon="issues" title="No issues match these filters">
            Raise an issue to track something that needs attention.
          </EmptyState>
        ))}
      {items && nextCursor && (
        <InfiniteScroll
          autoLoad={!error}
          busy={loadingMore}
          cursor={nextCursor}
          onLoadMore={loadMore}
        >
          Load more issues
        </InfiniteScroll>
      )}
    </div>
  );
}
