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
import { useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";
import { FinanceTransactionRow } from "./FinanceTransactionHistory";
import { FinanceTransactionSourceData } from "./FinanceTransactionSourceData";
import {
  type ExpenseCategory,
  type FinanceTransaction,
  type FinanceTransactionAnnotationInput,
  type FinanceTransactionSource,
  getFinanceTransaction,
  setTransactionCategory,
  updateFinanceTransactionAnnotation,
} from "./financeApi";
import { IssueList } from "./IssueList";
import { type IssueFilters, transactionIssuePath } from "./issuesApi";

export function FinanceTransactionPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const {
    data,
    error,
    busy,
    expanded,
    setExpanded,
    refresh,
    annotate,
    categorize,
  } = useTransaction(id);
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
              refreshKey={refresh}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load transaction.";
}

function useTransaction(id: string) {
  const [data, setData] = useState<{
    transaction: FinanceTransaction;
    categories: ExpenseCategory[];
    source: FinanceTransactionSource;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void getFinanceTransaction(id)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [id]);
  async function annotate(
    _: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) {
    setBusy(true);
    setError(undefined);
    try {
      const { annotation } = await updateFinanceTransactionAnnotation(
        id,
        input,
      );
      setData(
        (current) =>
          current && {
            ...current,
            transaction: { ...current.transaction, annotation },
          },
      );
      setExpanded(undefined);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function categorize(_: FinanceTransaction, categoryId: string | null) {
    setBusy(true);
    setError(undefined);
    try {
      await setTransactionCategory(id, categoryId);
      setData(
        (current) =>
          current && {
            ...current,
            transaction: {
              ...current.transaction,
              expenseCategoryId: categoryId,
            },
          },
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    data,
    error,
    busy,
    expanded,
    setExpanded,
    refresh,
    annotate,
    categorize,
  };
}
