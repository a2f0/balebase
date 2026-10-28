import type { FinanceFilters } from "@balebase/api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  PageSection,
  Select,
} from "@balebase/ui/react";
import type {
  ExpenseCategory,
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import type { LinkedEmail } from "@balebase/validators/inbox";
import { type FormEvent, useState } from "react";
import { AppLink } from "./AppLink";
import { FinanceTransactionFilters } from "./FinanceTransactionFilters";
import { formatMoney } from "./financeFormat";
import { InfiniteScroll } from "./InfiniteScroll";
import { formatCalendarDate, formatLabel } from "./labels";
import {
  financeTransactionPath,
  inboxEmailPath,
  transactionIssuePath,
} from "./workspacePaths";

interface AnnotationHandlers {
  busy: boolean;
  categories: ExpenseCategory[];
  onNavigate: (pathname: string) => void;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotation,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
  ) => Promise<void>;
  onSelectAnnotation: (transactionId: string) => void;
  selectedTransactionId: string | undefined;
}

export function FinanceTransactionHistory({
  accountName,
  onClearFilter,
  filters,
  onFiltersChange,
  nextCursor,
  loadingMore,
  loadError,
  loadMoreError,
  onLoadMore,
  onReload,
  transactions,
  ...handlers
}: AnnotationHandlers & {
  accountName: string | undefined;
  onClearFilter: () => void;
  filters: FinanceFilters;
  onFiltersChange: (filters: FinanceFilters) => void;
  nextCursor: string | null | undefined;
  loadingMore: boolean;
  loadError: string | undefined;
  loadMoreError: string | undefined;
  onLoadMore: () => Promise<boolean>;
  onReload: () => Promise<void>;
  transactions: FinanceTransaction[] | undefined;
}) {
  return (
    <PageSection
      actions={
        <TransactionSummary
          accountName={accountName}
          onClearFilter={onClearFilter}
          transactions={transactions}
        />
      }
      title="Transactions"
    >
      <FinanceTransactionFilters
        categories={handlers.categories}
        filters={filters}
        onChange={onFiltersChange}
      />
      <CategoryFilterNotice
        categories={handlers.categories}
        filters={filters}
        loaded={Boolean(transactions)}
        onNavigate={handlers.onNavigate}
      />
      {Boolean(transactions?.length) && !handlers.categories.length && (
        <Banner
          actions={
            <Button
              onClick={() => handlers.onNavigate("/finance/categories")}
              size="sm"
            >
              Set up categories
            </Button>
          }
          announce={false}
          icon="layers"
          title="Sort spending into expense categories"
        >
          Give each transaction a category to see totals by category in Reports.
        </Banner>
      )}
      {loadError && (
        <Banner
          tone="danger"
          actions={
            <Button onClick={() => void onReload()} size="sm">
              Retry
            </Button>
          }
        >
          {loadError}
        </Banner>
      )}
      {(!loadError || transactions) && (
        <TransactionContent
          filtered={
            filters.accountIds.length > 0 ||
            filters.categorySlug !== null ||
            filters.year !== null ||
            filters.uncategorized
          }
          transactions={transactions}
          {...handlers}
        />
      )}
      {loadMoreError && <Banner tone="danger">{loadMoreError}</Banner>}
      {nextCursor && transactions && (
        <InfiniteScroll
          autoLoad={!loadError && !loadMoreError}
          cursor={nextCursor}
          busy={loadingMore}
          disabled={handlers.busy}
          onLoadMore={onLoadMore}
        >
          {loadMoreError ? "Retry loading more" : "Load more transactions"}
        </InfiniteScroll>
      )}
    </PageSection>
  );
}

function TransactionSummary({
  accountName,
  onClearFilter,
  transactions,
}: {
  accountName: string | undefined;
  onClearFilter: () => void;
  transactions: FinanceTransaction[] | undefined;
}) {
  return (
    <div className="cluster">
      <span className="sectionCount" aria-live="polite">
        {transactions ? `${transactions.length} shown` : ""}
        {accountName ? ` for ${accountName}` : ""}
      </span>
      {accountName && (
        <Button icon="close" onClick={onClearFilter} size="sm" variant="ghost">
          All accounts
        </Button>
      )}
    </div>
  );
}

/** Explains the uncategorized filter, or a category path that matches nothing. */
function CategoryFilterNotice({
  categories,
  filters,
  loaded,
  onNavigate,
}: {
  categories: ExpenseCategory[];
  filters: FinanceFilters;
  loaded: boolean;
  onNavigate: (pathname: string) => void;
}) {
  if (filters.uncategorized) {
    return (
      <p className="textSm textSubtle">
        Posted expenses without a category. Income, transfers, and loan or card
        payments are excluded.
      </p>
    );
  }
  const slug = filters.categorySlug;
  if (!slug || !loaded || categories.some((item) => item.slug === slug)) {
    return null;
  }
  return (
    <Banner
      actions={
        <Button onClick={() => onNavigate("/finance/categories")} size="sm">
          View categories
        </Button>
      }
      title="Category not found"
      tone="warning"
    >
      No expense category uses the link “{slug}”. Renaming a category changes
      its link.
    </Banner>
  );
}

function TransactionContent({
  filtered,
  transactions,
  ...handlers
}: AnnotationHandlers & {
  filtered: boolean;
  transactions: FinanceTransaction[] | undefined;
}) {
  if (!transactions) return <LoadingState label="Loading finances…" />;
  if (!transactions.length) {
    return (
      <EmptyState
        icon={filtered ? "search" : "finance"}
        title={
          filtered
            ? "No transactions match these filters"
            : "No transactions imported yet"
        }
      >
        {filtered
          ? "Try another account or period, or clear the filters."
          : "Connect an account or sync an existing connection."}
      </EmptyState>
    );
  }
  return (
    <Card className="financeListCard" flush>
      <ul className="rowList financeTransactions">
        {transactions.map((transaction) => (
          <FinanceTransactionRow
            key={transaction.id}
            transaction={transaction}
            {...handlers}
          />
        ))}
      </ul>
    </Card>
  );
}

export function FinanceTransactionRow({
  busy,
  categories,
  onAnnotate,
  onCategorize,
  onNavigate,
  onSelectAnnotation,
  selectedTransactionId,
  transaction,
}: AnnotationHandlers & { transaction: FinanceTransaction }) {
  const expanded = selectedTransactionId === transaction.id;
  const formId = `annotation-${transaction.id}`;
  const title = transaction.merchantName ?? transaction.name;
  return (
    <li className="row financeTransaction">
      <time
        className="financeTransactionDate"
        dateTime={transaction.transactionDate}
      >
        {formatCalendarDate(transaction.transactionDate, {
          day: "numeric",
          month: "short",
        })}
      </time>
      <div className="rowMain financeTransactionMain">
        <AppLink
          className="rowTitle financeTransactionName"
          href={financeTransactionPath(transaction.id)}
          onNavigate={onNavigate}
        >
          {title}
        </AppLink>
        <span className="rowMeta financeTransactionMeta">
          {transactionMeta(transaction)}
        </span>
        <LinkedEmailChips
          emails={transaction.linkedEmails}
          onNavigate={onNavigate}
        />
      </div>
      <div className="financeTransactionCategory">
        {categories.length > 0 && (
          <Select
            disabled={busy}
            aria-label={`Expense category for ${title}`}
            className={cx(
              "inputSm",
              !transaction.expenseCategoryId && "financeCategoryUnset",
            )}
            onChange={(event) =>
              void onCategorize(transaction, event.target.value || null)
            }
            value={transaction.expenseCategoryId ?? ""}
          >
            <option value="">Uncategorized</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="cluster financeTransactionStatus">
        {transaction.pending && <Badge tone="warning">Pending</Badge>}
        {transaction.annotation.reviewed && (
          <Badge tone="success">Reviewed</Badge>
        )}
      </div>
      <span
        className={cx(
          "financeAmount",
          transaction.amount < 0 && "financeAmountCredit",
        )}
      >
        {formatMoney(-transaction.amount, transaction.currencyCode)}
      </span>
      <div className="financeTransactionActions">
        <Button
          aria-controls={expanded ? formId : undefined}
          aria-expanded={expanded}
          className="financeTransactionAction"
          icon="edit"
          onClick={() => onSelectAnnotation(transaction.id)}
          size="sm"
          variant="ghost"
        >
          {hasAnnotation(transaction) ? "Edit note" : "Annotate"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="issues"
          onClick={() => onNavigate(transactionIssuePath(transaction.id))}
        >
          Raise issue
        </Button>
      </div>
      {expanded && (
        <TransactionAnnotationForm
          busy={busy}
          id={formId}
          key={transaction.id}
          onClose={() => onSelectAnnotation(transaction.id)}
          onSave={(input) => onAnnotate(transaction, input)}
          transaction={transaction}
        />
      )}
    </li>
  );
}

/** Inbox emails, such as receipts, linked to a transaction. */
function LinkedEmailChips({
  emails,
  onNavigate,
}: {
  emails: LinkedEmail[];
  onNavigate: (pathname: string) => void;
}) {
  if (!emails.length) return null;
  return (
    <span className="financeTransactionEmails">
      {emails.map((email) => {
        const path = inboxEmailPath(email.id, email.status);
        return (
          <AppLink
            className="financeEmailChip"
            href={path}
            key={email.linkId}
            onNavigate={onNavigate}
          >
            <Icon name="mail" size={14} />
            <span className="truncate">{email.subject || "(no subject)"}</span>
          </AppLink>
        );
      })}
    </span>
  );
}

function TransactionAnnotationForm({
  busy,
  id,
  onClose,
  onSave,
  transaction,
}: {
  busy: boolean;
  id: string;
  onClose: () => void;
  onSave: (input: FinanceTransactionAnnotation) => Promise<void>;
  transaction: FinanceTransaction;
}) {
  const [labels, setLabels] = useState(
    transaction.annotation.labels.join(", "),
  );
  const [note, setNote] = useState(transaction.annotation.note);
  const [reviewed, setReviewed] = useState(transaction.annotation.reviewed);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        note,
        reviewed,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-label={`Annotation for ${transaction.merchantName ?? transaction.name}`}
      className="financeAnnotation"
      id={id}
      onSubmit={(event) => void submit(event)}
    >
      <div className="financeAnnotationHeader">
        <p className="eyebrow">Transaction annotation</p>
        <Button icon="close" onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>
      <div className="formGrid">
        <Field label="Labels">
          <input
            className="input"
            onChange={(event) => setLabels(event.target.value)}
            placeholder="tax, travel, follow up"
            value={labels}
          />
        </Field>
        <Field label="Note">
          <textarea
            className="textarea"
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add context to this transaction…"
            rows={3}
            value={note}
          />
        </Field>
      </div>
      <div className="financeAnnotationFooter">
        <label className="check">
          <input
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
            type="checkbox"
          />
          Reviewed
        </label>
        <Button busy={saving} disabled={busy} type="submit" variant="primary">
          {saving ? "Saving…" : "Save annotation"}
        </Button>
      </div>
    </form>
  );
}

/** The account, plus the bank's own category as context when it has one. */
function transactionMeta(transaction: FinanceTransaction) {
  return transaction.categoryPrimary
    ? `${transaction.accountName} · ${formatLabel(transaction.categoryPrimary)}`
    : transaction.accountName;
}

function hasAnnotation(transaction: FinanceTransaction) {
  const annotation = transaction.annotation;
  return Boolean(
    annotation.note || annotation.labels.length || annotation.reviewed,
  );
}
