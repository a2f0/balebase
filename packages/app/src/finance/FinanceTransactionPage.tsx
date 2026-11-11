import type { IssueFilters } from "@balebase/api-client";
import {
  Banner,
  Button,
  Card,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  useSectionTabs,
} from "@balebase/ui/react";
import type {
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import { useCallback, useMemo, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { IssueList } from "../issues/IssueList";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { transactionIssuePath } from "../workspace/workspacePaths";
import { FinanceTransactionRow } from "./FinanceTransactionHistory";
import { FinanceTransactionSourceData } from "./FinanceTransactionSourceData";
import { type CacheScope, catchUpSavedTransactions } from "./transactionCache";
import { useGuardedLoad } from "./useCacheScope";

export function FinanceTransactionPage({
  id,
  onNavigate,
  scope,
}: {
  id: string;
  onNavigate: (path: string) => void;
  /** Whose saved transactions this page's changes reach. */
  scope?: CacheScope | undefined;
}) {
  const {
    data,
    error,
    busy,
    expanded,
    setExpanded,
    annotate,
    categorize,
    guard,
  } = useTransaction(id, scope);
  const filters = useMemo<IssueFilters>(
    () => ({ status: "all", type: "finance_transaction", targetId: id, q: "" }),
    [id],
  );
  const sections = useSectionTabs([
    { id: "issues", label: "Issues" },
    { id: "source", label: "Source data" },
    { id: "activity", label: "Activity" },
  ]);
  return (
    <Page>
      <PageHeader
        eyebrow="Finance"
        tabs={data && sections.tabs}
        tabsKind="panels"
        tabsLabel="Transaction sections"
        title={
          data?.transaction.merchantName ??
          data?.transaction.name ??
          "Transaction"
        }
        actions={
          <Button onClick={() => onNavigate("/finance")}>
            All transactions
          </Button>
        }
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {!data && !error && <LoadingState label="Loading transaction…" />}
        {data && (
          <>
            <Card className="financeListCard" flush>
              <ul className="rowList financeTransactions">
                <FinanceTransactionRow
                  transaction={data.transaction}
                  categories={data.categories}
                  busy={busy}
                  onNavigate={onNavigate}
                  onOpen={() => sections.select("source")}
                  onAnnotate={annotate}
                  onCategorize={categorize}
                  selectedTransactionId={expanded}
                  onSelectAnnotation={(value) =>
                    setExpanded((current) =>
                      current === value ? undefined : value,
                    )
                  }
                />
              </ul>
            </Card>
            {sections.panel(
              "issues",
              <PageSection
                title="Issues"
                actions={
                  <Button onClick={() => onNavigate(transactionIssuePath(id))}>
                    Raise issue
                  </Button>
                }
              >
                <IssueList filters={filters} onNavigate={onNavigate} />
              </PageSection>,
            )}
            {sections.panel(
              "source",
              <FinanceTransactionSourceData
                source={data.source}
                transaction={data.transaction}
              />,
            )}
            {sections.panel(
              "activity",
              <ActivityFeed
                guard={guard}
                source={{ type: "finance_transaction", id }}
                refreshKey={data.transaction}
              />,
            )}
          </>
        )}
      </PageBody>
    </Page>
  );
}
function useTransaction(id: string, givenScope: CacheScope | undefined) {
  const loaded = useGuardedLoad(
    givenScope,
    useCallback(() => api.finance.transaction(id), [id]),
    "Could not load transaction.",
  );
  const { guard, scope, setData } = loaded;
  const action = useAction("Could not update the transaction.");
  const [expanded, setExpanded] = useState<string>();
  const updateTransaction = (change: Partial<FinanceTransaction>) =>
    setData(
      (current) =>
        current && {
          ...current,
          transaction: { ...current.transaction, ...change },
        },
    );
  async function annotate(
    _: FinanceTransaction,
    input: FinanceTransactionAnnotation,
  ) {
    await action.run(async () => {
      const { annotation } = await guard(
        api.finance.updateTransactionAnnotation(id, input),
      );
      updateTransaction({ annotation });
      setExpanded(undefined);
    });
    void catchUp();
  }
  function catchUp() {
    return guard(
      catchUpSavedTransactions(scope, (cursor) =>
        api.finance.transactionChanges(cursor),
      ),
    ).catch(() => {
      // A refusal has cleared the page; anything else waits for a load.
    });
  }
  async function categorize(_: FinanceTransaction, categoryId: string | null) {
    await action.run(async () => {
      await guard(api.finance.setTransactionCategory(id, categoryId));
      updateTransaction({ expenseCategoryId: categoryId });
    });
    void catchUp();
  }

  return {
    data: loaded.data,
    error: action.error ?? loaded.error,
    busy: action.busy,
    expanded,
    setExpanded,
    annotate,
    categorize,
    guard,
  };
}
