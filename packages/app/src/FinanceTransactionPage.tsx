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
} from "@balebase/ui/react";
import type {
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import { useCallback, useMemo, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";
import { api } from "./apiClient";
import { FinanceTransactionRow } from "./FinanceTransactionHistory";
import { FinanceTransactionSourceData } from "./FinanceTransactionSourceData";
import { IssueList } from "./IssueList";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import { transactionIssuePath } from "./workspacePaths";

export function FinanceTransactionPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const { data, error, busy, expanded, setExpanded, annotate, categorize } =
    useTransaction(id);
  const filters = useMemo<IssueFilters>(
    () => ({ status: "all", type: "finance_transaction", targetId: id, q: "" }),
    [id],
  );
  return (
    <Page>
      <PageHeader
        eyebrow="Finance"
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
            <FinanceTransactionSourceData
              source={data.source}
              transaction={data.transaction}
            />
            <PageSection
              title="Issues"
              actions={
                <Button onClick={() => onNavigate(transactionIssuePath(id))}>
                  Raise issue
                </Button>
              }
            >
              <IssueList filters={filters} onNavigate={onNavigate} />
            </PageSection>
            <ActivityFeed
              source={{ type: "finance_transaction", id }}
              refreshKey={data.transaction}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}
function useTransaction(id: string) {
  const loaded = useLoad(
    useCallback(() => api.finance.transaction(id), [id]),
    "Could not load transaction.",
  );
  const { setData } = loaded;
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
      const { annotation } = await api.finance.updateTransactionAnnotation(
        id,
        input,
      );
      updateTransaction({ annotation });
      setExpanded(undefined);
    });
  }
  async function categorize(_: FinanceTransaction, categoryId: string | null) {
    await action.run(async () => {
      await api.finance.setTransactionCategory(id, categoryId);
      updateTransaction({ expenseCategoryId: categoryId });
    });
  }

  return {
    data: loaded.data,
    error: action.error ?? loaded.error,
    busy: action.busy,
    expanded,
    setExpanded,
    annotate,
    categorize,
  };
}
