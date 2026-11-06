import type { FinanceFilters } from "@balebase/api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ContextMenu,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  MenuButton,
  PageSection,
  Select,
} from "@balebase/ui/react";
import type {
  ExpenseCategory,
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import type { LinkedEmail } from "@balebase/validators/inbox";
import { financeLimits } from "@balebase/validators/rules";
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useState,
} from "react";
import { AppLink } from "../shared/AppLink";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { countLabel, formatCalendarDate, formatLabel } from "../shared/labels";
import {
  financeRulePath,
  financeTransactionPath,
  inboxEmailPath,
  transactionIssuePath,
} from "../workspace/workspacePaths";
import {
  FinancePayeeList,
  type TransactionView,
  TransactionViewSwitch,
} from "./FinancePayeeList";
import {
  FinanceTransactionFilters,
  hasTransactionFilters,
} from "./FinanceTransactionFilters";
import {
  TransactionSelectCheckbox,
  type TransactionSelection,
  TransactionSelectionBar,
  useTransactionSelection,
} from "./FinanceTransactionSelection";
import { formatMoney } from "./financeFormat";
import { groupByPayee, type PayeeGroup, transactionTitle } from "./payeeGroups";

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
  /** Lists only transactions shown under a name; absent outside the list. */
  onFilterByName?: ((name: string) => void) | undefined;
  selectedTransactionId: string | undefined;
}

/** Gives several transactions one category; true once it is saved. */
type CategorizeMany = (
  transactions: FinanceTransaction[],
  categoryId: string | null,
) => Promise<boolean>;

export function FinanceTransactionHistory({
  accountName,
  onClearFilter,
  filters,
  onFiltersChange,
  loadError,
  loadingLabel,
  matching,
  onCategorizeMany,
  onLoadMore,
  onReload,
  visible,
  ...handlers
}: Omit<AnnotationHandlers, "onFilterByName"> & {
  accountName: string | undefined;
  /** Shown while the list loads, such as a first download's progress. */
  loadingLabel?: string | undefined;
  /** Every transaction the filters match, newest first; absent while loading. */
  matching: FinanceTransaction[] | undefined;
  /** How many rows (transactions or payees) to show; the end shows more. */
  visible: number;
  onCategorizeMany: CategorizeMany;
  onClearFilter: () => void;
  filters: FinanceFilters;
  onFiltersChange: (filters: FinanceFilters) => void;
  loadError: string | undefined;
  onLoadMore: () => Promise<boolean>;
  onReload: () => Promise<void>;
}) {
  const [view, setView] = useState<TransactionView>("list");
  const transactions = matching?.slice(0, visible);
  // Payees group everything the filters match, not only the rows shown.
  const payees =
    view === "payees" && matching ? groupByPayee(matching) : undefined;
  const listed = payees ?? matching;
  // Names the view and filters too: InfiniteScroll asks once per cursor, and
  // the same count under another view or filters is a new place.
  const nextCursor =
    listed && listed.length > visible
      ? `${view}:${JSON.stringify(filters)}#${visible}`
      : null;
  // Any change to the filters (toolbar, account cards, Back) starts afresh.
  const selection = useTransactionSelection(
    transactions,
    JSON.stringify(filters),
  );
  return (
    <PageSection
      actions={
        <TransactionSummary
          accountName={accountName}
          label={summaryLabel(matching, payees, visible)}
          onClearFilter={onClearFilter}
        />
      }
      title="Transactions"
    >
      <FinanceTransactionFilters
        categories={handlers.categories}
        filters={filters}
        onChange={onFiltersChange}
      >
        <TransactionViewSwitch onChange={setView} view={view} />
      </FinanceTransactionFilters>
      <CategoryFilterNotice
        categories={handlers.categories}
        filters={filters}
        loaded={Boolean(matching)}
        onNavigate={handlers.onNavigate}
      />
      <CategorySetupBanner
        onNavigate={handlers.onNavigate}
        shown={Boolean(matching?.length) && !handlers.categories.length}
      />
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
      {(!loadError || matching) &&
        (payees?.length ? (
          <FinancePayeeList
            onSelect={(name) => {
              setView("list");
              onFiltersChange({ ...filters, name });
            }}
            payees={payees.slice(0, visible)}
          />
        ) : (
          <TransactionContent
            filtered={hasTransactionFilters(filters)}
            loadingLabel={loadingLabel}
            onCategorizeMany={onCategorizeMany}
            onFilterByName={(name) => onFiltersChange({ ...filters, name })}
            selection={selection}
            transactions={transactions}
            {...handlers}
          />
        ))}
      {nextCursor && (
        <InfiniteScroll
          autoLoad={!loadError}
          cursor={nextCursor}
          busy={false}
          disabled={handlers.busy}
          onLoadMore={onLoadMore}
        >
          {view === "payees" ? "Load more payees" : "Load more transactions"}
        </InfiniteScroll>
      )}
    </PageSection>
  );
}

/** "250 of 300 shown", or for payees "12 payees · 40 transactions". */
function summaryLabel(
  matching: FinanceTransaction[] | undefined,
  payees: PayeeGroup[] | undefined,
  visible: number,
) {
  if (!matching) return "";
  const of = (total: number) =>
    total > visible
      ? `${visible.toLocaleString()} of ${total.toLocaleString()}`
      : total.toLocaleString();
  if (payees) {
    const noun = payees.length === 1 ? "payee" : "payees";
    return `${of(payees.length)} ${noun} · ${countLabel(matching.length, "transaction")}`;
  }
  return `${of(matching.length)} shown`;
}

function CategorySetupBanner({
  onNavigate,
  shown,
}: {
  onNavigate: (pathname: string) => void;
  shown: boolean;
}) {
  if (!shown) return null;
  return (
    <Banner
      actions={
        <Button onClick={() => onNavigate("/finance/categories")} size="sm">
          Set up categories
        </Button>
      }
      announce={false}
      icon="layers"
      title="Sort spending into expense categories"
    >
      Give each transaction a category to see totals by category in Reports.
    </Banner>
  );
}

function TransactionSummary({
  accountName,
  label,
  onClearFilter,
}: {
  accountName: string | undefined;
  label: string;
  onClearFilter: () => void;
}) {
  return (
    <div className="cluster">
      <span className="sectionCount" aria-live="polite">
        {label}
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
  loadingLabel,
  onCategorizeMany,
  selection,
  transactions,
  ...handlers
}: AnnotationHandlers & {
  filtered: boolean;
  loadingLabel: string | undefined;
  onCategorizeMany: CategorizeMany;
  selection: TransactionSelection;
  transactions: FinanceTransaction[] | undefined;
}) {
  if (!transactions)
    return <LoadingState label={loadingLabel ?? "Loading finances…"} />;
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
  // Selection only categorizes, so it waits for categories to exist.
  const selectable = handlers.categories.length > 0;
  return (
    <Card className="financeListCard" flush>
      {selectable && (
        <TransactionSelectionBar
          busy={handlers.busy}
          categories={handlers.categories}
          onCategorize={onCategorizeMany}
          selection={selection}
        />
      )}
      <ul
        className={cx(
          "rowList financeTransactions",
          selectable && "financeSelectable",
        )}
      >
        {transactions.map((transaction) => (
          <FinanceTransactionRow
            key={transaction.id}
            select={
              selectable
                ? {
                    checked: selection.isSelected(transaction.id),
                    onToggle: (range) =>
                      selection.toggle(transaction.id, range),
                  }
                : undefined
            }
            transaction={transaction}
            {...handlers}
          />
        ))}
      </ul>
    </Card>
  );
}

/**
 * A transaction row. Its menu, from the menu button or a right-click anywhere
 * on the row, annotates it, raises an issue, or lists its name's transactions.
 */
export function FinanceTransactionRow(
  props: AnnotationHandlers & {
    /** The row's checkbox, in lists that select rows for bulk changes. */
    select?: RowSelect | undefined;
    transaction: FinanceTransaction;
  },
) {
  const title = transactionTitle(props.transaction);
  const label = `Actions for ${title}`;
  return (
    <ContextMenu items={transactionMenuItems(props)} label={label}>
      {(target, menuButton) => (
        <TransactionRowContent
          {...props}
          menuButton={<MenuButton {...menuButton} label={label} />}
          target={target}
        />
      )}
    </ContextMenu>
  );
}

function transactionMenuItems({
  categories,
  onFilterByName,
  onNavigate,
  onSelectAnnotation,
  selectedTransactionId,
  transaction,
}: AnnotationHandlers & { transaction: FinanceTransaction }) {
  const title = transactionTitle(transaction);
  const items: ComponentProps<typeof ContextMenu>["items"][number][] = [
    {
      icon: "edit",
      id: "annotate",
      label: hasAnnotation(transaction) ? "Edit note" : "Annotate",
      onSelect: () => {
        // Selecting it again keeps an open form open; Close closes it.
        if (selectedTransactionId !== transaction.id) {
          onSelectAnnotation(transaction.id);
        }
      },
    },
    {
      icon: "issues",
      id: "raise-issue",
      label: "Raise issue",
      onSelect: () => onNavigate(transactionIssuePath(transaction.id)),
    },
  ];
  if (onFilterByName) {
    items.push({
      icon: "search",
      id: "same-name",
      label: `Show only “${title}”`,
      onSelect: () => onFilterByName(title),
    });
  }
  // A rule names a category: with none yet, the overview offers setting
  // categories up instead (and a payee sent to Rules would be lost there).
  if (onFilterByName && categories.length > 0) {
    items.push({
      icon: "layers",
      id: "create-rule",
      label: `Create rule for “${title}”`,
      onSelect: () => onNavigate(financeRulePath(title)),
    });
  }
  return items;
}

interface RowSelect {
  checked: boolean;
  onToggle: (range: boolean) => void;
}

function TransactionRowContent({
  busy,
  categories,
  menuButton,
  onAnnotate,
  onCategorize,
  onNavigate,
  onSelectAnnotation,
  select,
  selectedTransactionId,
  target,
  transaction,
}: AnnotationHandlers & {
  menuButton: ReactNode;
  select?: RowSelect | undefined;
  target: Parameters<ComponentProps<typeof ContextMenu>["children"]>[0];
  transaction: FinanceTransaction;
}) {
  const expanded = selectedTransactionId === transaction.id;
  const title = transactionTitle(transaction);
  return (
    <li className="row financeTransaction" {...target}>
      {select && (
        <TransactionSelectCheckbox
          checked={select.checked}
          disabled={busy}
          label={`Select ${title}`}
          onToggle={select.onToggle}
        />
      )}
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
      <div className="financeTransactionActions">{menuButton}</div>
      {expanded && (
        <TransactionAnnotationForm
          busy={busy}
          id={`annotation-${transaction.id}`}
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
            maxLength={financeLimits.annotationNote}
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
