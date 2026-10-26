import type { IssueFilters } from "@balebase/api-client";
import {
  Banner,
  Button,
  Card,
  Field,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Select,
} from "@balebase/ui/react";
import type { Issue, IssueInput } from "@balebase/validators/issues";
import { useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";
import { api } from "./apiClient";
import { financeTransactionPath } from "./financePages";
import { IssueForm } from "./IssueForm";
import { IssueImages } from "./IssueImages";
import { IssueList } from "./IssueList";
import { issuePath } from "./issuePaths";
import { decodeRecordId } from "./workspacePaths";

export function Issues({
  pathname,
  onNavigate,
  canAccessFinance,
}: {
  pathname: string;
  onNavigate: (path: string) => void;
  canAccessFinance: boolean;
}) {
  if (pathname === "/issues/new")
    return <NewIssue key={pathname} onNavigate={onNavigate} />;
  const transaction = /^\/issues\/new\/transactions\/([^/]+)$/.exec(pathname);
  if (transaction)
    return (
      <NewIssue
        key={pathname}
        transactionId={decodeRecordId(transaction[1] ?? "")}
        onNavigate={onNavigate}
      />
    );
  const match = /^\/issues\/([^/]+)$/.exec(pathname);
  if (match)
    return (
      <IssueDetail
        key={pathname}
        id={decodeRecordId(match[1] ?? "")}
        onNavigate={onNavigate}
      />
    );
  return (
    <IssuesIndex canAccessFinance={canAccessFinance} onNavigate={onNavigate} />
  );
}

function IssuesIndex({
  onNavigate,
  canAccessFinance,
}: {
  onNavigate: (path: string) => void;
  canAccessFinance: boolean;
}) {
  const [filters, setFilters] = useState<IssueFilters>({
    status: "open",
    type: "all",
    q: "",
  });
  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Issues"
        description="Track, assign, and resolve things that need attention across your workspace."
        actions={
          <Button
            icon="add"
            variant="primary"
            onClick={() => onNavigate("/issues/new")}
          >
            Raise issue
          </Button>
        }
      />
      <PageBody>
        <Button icon="download" onClick={() => onNavigate("/offline")}>
          Create issues offline with photos
        </Button>
        <fieldset className="issueToolbar" aria-label="Issue filters">
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  status: event.target.value as IssueFilters["status"],
                })
              }
            >
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="all">All statuses</option>
            </Select>
          </Field>
          <Field label="Source">
            <Select
              value={filters.type}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  type: event.target.value as IssueFilters["type"],
                })
              }
            >
              <option value="all">All sources</option>
              <option value="audit_run">Audits</option>
              {canAccessFinance && (
                <option value="finance_transaction">Transactions</option>
              )}
              <option value="workspace">Workspace</option>
            </Select>
          </Field>
          <Field label="Search issues">
            <input
              className="input"
              type="search"
              maxLength={200}
              value={filters.q}
              onChange={(event) =>
                setFilters({ ...filters, q: event.target.value })
              }
              placeholder="Search by title…"
            />
          </Field>
        </fieldset>
        <IssueList filters={filters} onNavigate={onNavigate} />
      </PageBody>
    </Page>
  );
}

function NewIssue({
  onNavigate,
  transactionId,
}: {
  onNavigate: (path: string) => void;
  transactionId?: string;
}) {
  const [label, setLabel] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!transactionId) return;
    let active = true;
    void api.finance
      .transaction(transactionId)
      .then(({ transaction }) => {
        if (active) setLabel(transaction.merchantName ?? transaction.name);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [transactionId]);
  async function save(input: IssueInput) {
    const { issueId } = await api.issues.create(
      input,
      transactionId
        ? { type: "finance_transaction", id: transactionId }
        : undefined,
    );
    onNavigate(issuePath(issueId));
  }
  return (
    <Page>
      <PageHeader
        eyebrow={transactionId ? "Transaction issue" : "Workspace issue"}
        title="Raise issue"
        description={label}
        actions={
          <Button
            onClick={() =>
              onNavigate(
                transactionId
                  ? financeTransactionPath(transactionId)
                  : "/issues",
              )
            }
          >
            Cancel
          </Button>
        }
      />
      <PageBody>
        {error ? (
          <Banner tone="danger">{error}</Banner>
        ) : transactionId && !label ? (
          <LoadingState label="Loading transaction…" />
        ) : (
          <Card>
            <IssueForm onSave={save} />
          </Card>
        )}
      </PageBody>
    </Page>
  );
}

function IssueDetail({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const [issue, setIssue] = useState<Issue>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [formVersion, setFormVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const request = useMemo(() => ({ id, reload }), [id, reload]);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void api.issues
      .get(request.id)
      .then((data) => {
        if (active) {
          setIssue(data.issue);
          setFormVersion((value) => value + 1);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [request]);
  async function save(
    input: Partial<IssueInput> & { status?: Issue["status"] },
  ) {
    if (!issue) return;
    setBusy(true);
    try {
      const data = await api.issues.update(id, {
        ...input,
        expectedRevision: issue.revision,
      });
      setIssue(data.issue);
      setError(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <PageHeader
        eyebrow="Issues"
        title={issue?.title ?? "Issue"}
        actions={
          <Button onClick={() => onNavigate("/issues")}>All issues</Button>
        }
      />
      <PageBody>
        {error && (
          <Banner
            tone="danger"
            actions={
              <Button onClick={() => setReload((value) => value + 1)}>
                Reload issue
              </Button>
            }
          >
            {error}
          </Banner>
        )}
        {!issue && !error && <LoadingState label="Loading issue…" />}
        {issue && (
          <>
            <IssueSource issue={issue} onNavigate={onNavigate} />
            <PageSection
              title={issue.status === "open" ? "Open issue" : "Resolved issue"}
              actions={
                <Button
                  busy={busy}
                  disabled={!issue.target.available}
                  onClick={() =>
                    void save({
                      status: issue.status === "open" ? "resolved" : "open",
                    }).catch((cause: unknown) => setError(message(cause)))
                  }
                >
                  {issue.status === "open" ? "Resolve issue" : "Reopen issue"}
                </Button>
              }
            >
              <Card>
                <IssueForm
                  key={`${id}:${formVersion}`}
                  initial={{
                    title: issue.title,
                    description: issue.description,
                    priority: issue.priority,
                    assignedTo: issue.assignedTo?.id ?? null,
                  }}
                  onSave={save}
                  onError={setError}
                  label="Save changes"
                  disabled={busy || !issue.target.available}
                />
              </Card>
            </PageSection>
            {issue.target.type !== "finance_transaction" && (
              <IssueImages issueId={id} />
            )}
            <ActivityFeed
              source={{ type: "issue", id }}
              refreshKey={issue.revision}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function IssueSource({
  issue,
  onNavigate,
}: {
  issue: Issue;
  onNavigate: (path: string) => void;
}) {
  const source = issue.target;
  if (!source.available)
    return (
      <Banner>
        The source is no longer available. This issue is read only.
      </Banner>
    );
  if (!source.id)
    return (
      <p className="textSubtle">
        Workspace issue · Raised by{" "}
        {issue.createdBy.name || issue.createdBy.email}
      </p>
    );
  const path =
    source.type === "finance_transaction"
      ? financeTransactionPath(source.id)
      : `/audits/runs/${encodeURIComponent(source.id)}`;
  return (
    <Banner
      icon={source.type === "finance_transaction" ? "finance" : "audits"}
      actions={
        <Button size="sm" onClick={() => onNavigate(path)}>
          Open {source.type === "finance_transaction" ? "transaction" : "audit"}
        </Button>
      }
    >
      {source.label}
    </Banner>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load issue.";
}
