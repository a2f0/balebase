import type { IssueFilters } from "@balebase/api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
} from "@balebase/ui/react";
import type { IssuePage } from "@balebase/validators/issues";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./apiClient";
import { issuePath } from "./issuePaths";
import { formatLabel } from "./labels";
import { handleNavigation } from "./workspacePaths";

export function IssueList({
  filters,
  onNavigate,
}: {
  filters: IssueFilters;
  onNavigate: (path: string) => void;
}) {
  const [page, setPage] = useState<IssuePage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const request = useMemo(() => ({ filters, reload }), [filters, reload]);
  useEffect(() => {
    const current = ++generation.current;
    setPage(undefined);
    setError(undefined);
    setBusy(false);
    void api.issues
      .list(request.filters)
      .then((next) => {
        if (current === generation.current) setPage(next);
      })
      .catch((cause: unknown) => {
        if (current === generation.current) setError(message(cause));
      });
    return () => {
      generation.current++;
    };
  }, [request]);
  async function loadMore() {
    if (!page?.nextCursor || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.issues.list(filters, page.nextCursor);
      if (current === generation.current)
        setPage({
          issues: [...page.issues, ...next.issues],
          nextCursor: next.nextCursor,
        });
    } catch (cause) {
      if (current === generation.current) setError(message(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <div className="stack">
      {error && (
        <Banner
          tone="danger"
          actions={
            <Button size="sm" onClick={() => setReload((value) => value + 1)}>
              Reload issues
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {!page && !error && <LoadingState label="Loading issues…" />}
      {page &&
        (page.issues.length ? (
          <Card flush>
            <ul aria-label="Issues" className="rowList">
              {page.issues.map((issue) => (
                <li className="row" key={issue.id}>
                  <div className="rowMain">
                    <a
                      className="rowTitle"
                      href={issuePath(issue.id)}
                      onClick={(event) =>
                        handleNavigation(event, issuePath(issue.id), onNavigate)
                      }
                    >
                      {issue.title}
                    </a>
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
      {page?.nextCursor && (
        <Button busy={busy} onClick={() => void loadMore()}>
          Load more issues
        </Button>
      )}
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load issues.";
}
