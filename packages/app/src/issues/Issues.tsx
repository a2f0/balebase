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
import { useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { useLoad } from "../shared/useLoad";
import {
  auditRunPath,
  financeTransactionPath,
  issuePath,
  recordIdForPath,
} from "../workspace/workspacePaths";
import { IssueForm } from "./IssueForm";
import { IssueImages } from "./IssueImages";
import { IssueList } from "./IssueList";

export function Issues({
  pathname,
  onNavigate,
  canAccessFinance,
}: {
  pathname: string;
  onNavigate: (path: string) => void;
  canAccessFinance: boolean;
}) {
  const transactionId = recordIdForPath(pathname, "/issues/new/transactions");
  if (transactionId)
    return (
      <NewIssue
        key={pathname}
        transactionId={transactionId}
        onNavigate={onNavigate}
      />
    );
  const id = recordIdForPath(pathname, "/issues");
  if (id === "new") return <NewIssue key={pathname} onNavigate={onNavigate} />;
  if (id) return <IssueDetail key={pathname} id={id} onNavigate={onNavigate} />;
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
  const { data: label, error } = useLoad(
    useCallback(async () => {
      if (!transactionId) return undefined;
      const { transaction } = await api.finance.transaction(transactionId);
      return transaction.merchantName ?? transaction.name;
    }, [transactionId]),
    "Could not load the transaction.",
  );
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
  const loaded = useLoad(
    useCallback(() => api.issues.get(id), [id]),
    "Could not load issue.",
  );
  const { setData } = loaded;
  const issue = loaded.data?.issue;
  const [failure, setFailure] = useState<string>();
  const error = failure ?? loaded.error;
  // A reload replaces edits in the form with what was stored.
  const [formVersion, setFormVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  async function reload() {
    setFailure(undefined);
    // A failed reload keeps the form, and its unsaved edits, in place.
    if (await loaded.reload()) setFormVersion((value) => value + 1);
  }
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
      setData(data);
      // The saved issue is current, so an earlier failed reload no longer applies.
      loaded.setError(undefined);
      setFailure(undefined);
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
              <Button onClick={() => void reload()}>Reload issue</Button>
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
                    }).catch((cause: unknown) =>
                      setFailure(errorMessage(cause, "Could not save issue.")),
                    )
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
                  onError={setFailure}
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
      : auditRunPath(source.id);
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
