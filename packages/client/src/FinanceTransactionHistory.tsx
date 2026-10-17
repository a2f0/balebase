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
} from "@balebase/ui/react";
import { type FormEvent, useState } from "react";
import type { LinkedEmail } from "./api";
import { FinanceTransactionFilters } from "./FinanceTransactionFilters";
import type {
  ExpenseCategory,
  FinanceFilters,
  FinanceTransaction,
  FinanceTransactionAnnotationInput,
} from "./financeApi";
import { formatMoney } from "./financeFormat";
import { formatLabel } from "./labels";
import { handleNavigation, inboxEmailPath } from "./workspacePaths";

interface AnnotationHandlers {
  busy: boolean;
  categories: ExpenseCategory[];
  onNavigate: (pathname: string) => void;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
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
  hasMore,
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
  hasMore: boolean;
  loadingMore: boolean;
  loadError: string | undefined;
  loadMoreError: string | undefined;
  onLoadMore: () => Promise<void>;
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
      <FinanceTransactionFilters filters={filters} onChange={onFiltersChange} />
      {filters.uncategorized && (
        <p className="textSm textSubtle">
          Posted expenses without a category. Income, transfers, and loan or
          card payments are excluded.
        </p>
      )}
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
            filters.year !== null ||
            filters.uncategorized
          }
          transactions={transactions}
          {...handlers}
        />
      )}
      {loadMoreError && <Banner tone="danger">{loadMoreError}</Banner>}
      {hasMore && transactions && (
        <Button busy={loadingMore} onClick={() => void onLoadMore()} size="sm">
          {loadMoreError ? "Retry loading more" : "Load more transactions"}
        </Button>
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
          <TransactionRow
            key={transaction.id}
            transaction={transaction}
            {...handlers}
          />
        ))}
      </ul>
    </Card>
  );
}

function TransactionRow({
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
        {formatDate(transaction.transactionDate)}
      </time>
      <div className="rowMain financeTransactionMain">
        <span className="rowTitle financeTransactionName">{title}</span>
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
          <select
            aria-label={`Expense category for ${title}`}
            className={cx(
              "select inputSm",
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
          </select>
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
          <a
            className="financeEmailChip"
            href={path}
            key={email.linkId}
            onClick={(event) => handleNavigation(event, path, onNavigate)}
          >
            <Icon name="mail" size={14} />
            <span className="truncate">{email.subject || "(no subject)"}</span>
          </a>
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
  onSave: (input: FinanceTransactionAnnotationInput) => Promise<void>;
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(`${value}T12:00:00`));
}
