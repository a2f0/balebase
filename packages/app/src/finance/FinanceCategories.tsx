import {
  Button,
  Card,
  confirmDialog,
  cx,
  EmptyState,
  Field,
  LoadingState,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { ExpenseCategory } from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { ListRow } from "../shared/ListRow";
import { countLabel } from "../shared/labels";
import { type CategoryTotals, periodTotals } from "./categoryYearCounts";
import {
  periodTransactionCount,
  readHideEmptyCategories,
  storeHideEmptyCategories,
  visibleCategories,
} from "./emptyCategories";
import { FinancePeriodFilter } from "./FinancePeriodFilter";
import { formatMoney } from "./financeFormat";
import { useFinanceSave } from "./financeSave";

export function FinanceCategories({
  categories,
  onChanged,
  onRefused,
  onShowTransactions,
  onYearChange,
  year,
}: {
  categories: ExpenseCategory[] | undefined;
  onChanged: () => Promise<void>;
  /** A save was refused: access ended. */
  onRefused: (cause: unknown) => Promise<void>;
  onShowTransactions: (category: ExpenseCategory) => void;
  onYearChange: (year: number | null) => void;
  /** Counts only transactions dated in this year; null counts them all. */
  year: number | null;
}) {
  const { busy, error, notice, run } = useFinanceSave(
    "Could not save the category.",
    onChanged,
    onRefused,
  );
  const [hideEmpty, setHideEmpty] = useState(readHideEmptyCategories);
  const changeHideEmpty = (hide: boolean) => {
    setHideEmpty(hide);
    storeHideEmptyCategories(hide);
  };
  const addDefaults = () =>
    run(async () => {
      const before = categories?.length ?? 0;
      const { categories: after } =
        await api.finance.addDefaultExpenseCategories();
      const added = after.length - before;
      return added > 0
        ? `Added ${countLabel(added, "common category", "common categories")}.`
        : "All common categories are already here.";
    });

  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      <AddCategoryForm
        busy={busy}
        onAdd={(name) =>
          run(async () => {
            await api.finance.createExpenseCategory(name);
            return `Added “${name}”.`;
          })
        }
      />
      <PageSection
        actions={
          categories?.length ? (
            <div className="cluster">
              <span className="sectionCount">
                {countLabel(categories.length, "category", "categories")}
              </span>
              <HideEmptySwitch hide={hideEmpty} onChange={changeHideEmpty} />
              <Button
                disabled={busy}
                icon="layers"
                onClick={() => void addDefaults()}
                size="sm"
              >
                Add common categories
              </Button>
            </div>
          ) : undefined
        }
        description="Each transaction can have one expense category. Reports total spending by category. Select a category to see its transactions in the chosen period, or open its menu to rename or delete it."
        title="Expense categories"
      >
        {categories?.length ? (
          <div className="cluster">
            <FinancePeriodFilter onChange={onYearChange} year={year} />
          </div>
        ) : null}
        <CategoryList
          busy={busy}
          categories={categories}
          hideEmpty={hideEmpty}
          onAddDefaults={addDefaults}
          onDelete={(category) =>
            run(async () => {
              await api.finance.deleteExpenseCategory(category.id);
              return `Deleted “${category.name}”.`;
            })
          }
          onRename={(category, name) =>
            run(async () => {
              await api.finance.renameExpenseCategory(category.id, name);
              return `Renamed to “${name}”.`;
            })
          }
          onShowTransactions={onShowTransactions}
          year={year}
        />
      </PageSection>
    </>
  );
}

function HideEmptySwitch({
  hide,
  onChange,
}: {
  hide: boolean;
  onChange: (hide: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        aria-checked={hide}
        checked={hide}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
      Hide categories with no transactions
    </label>
  );
}

function AddCategoryForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onAdd(name.trim())) setName("");
  }
  return (
    <Card
      description="Use names your bookkeeper will recognize, such as Meals or Software."
      footer={
        <Button
          busy={busy}
          disabled={!name.trim()}
          icon="add"
          type="submit"
          variant="primary"
        >
          Add category
        </Button>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a category"
    >
      <Field label="Category name">
        <input
          className="input"
          maxLength={financeLimits.categoryName}
          onChange={(event) => setName(event.target.value)}
          placeholder="Office supplies"
          required
          value={name}
        />
      </Field>
    </Card>
  );
}

function CategoryList({
  busy,
  categories,
  hideEmpty,
  onAddDefaults,
  onDelete,
  onRename,
  onShowTransactions,
  year,
}: {
  busy: boolean;
  categories: ExpenseCategory[] | undefined;
  hideEmpty: boolean;
  onAddDefaults: () => Promise<boolean>;
  onDelete: (category: ExpenseCategory) => Promise<boolean>;
  onRename: (category: ExpenseCategory, name: string) => Promise<boolean>;
  onShowTransactions: (category: ExpenseCategory) => void;
  year: number | null;
}) {
  if (!categories) return <LoadingState label="Loading categories…" />;
  if (!categories.length) {
    return (
      <EmptyState
        actions={
          <Button
            busy={busy}
            icon="layers"
            onClick={() => void onAddDefaults()}
            variant="primary"
          >
            Add common categories
          </Button>
        }
        icon="layers"
        title="No expense categories yet"
      >
        Start with a common set for small businesses, or add your own above.
      </EmptyState>
    );
  }
  const { hidden, shown } = visibleCategories(categories, hideEmpty, year);
  const period = year === null ? "" : ` in ${year}`;
  return (
    <>
      {shown.length > 0 ? (
        <Card flush>
          <ul className="rowList">
            {shown.map((category) => (
              <CategoryRow
                busy={busy}
                category={category}
                key={category.id}
                onDelete={onDelete}
                onRename={onRename}
                onShowTransactions={onShowTransactions}
                totals={periodTotals(category.transactionCountsByYear, year)}
                transactionCount={periodTransactionCount(category, year)}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState
          icon="layers"
          title={`No categories have transactions${period || " yet"}`}
        >
          Categorize transactions to see their categories here.
        </EmptyState>
      )}
      {hidden > 0 && (
        <p className="textMuted">
          {countLabel(hidden, "category", "categories")} with no transactions
          {period} {hidden === 1 ? "is" : "are"} hidden.
        </p>
      )}
    </>
  );
}

function CategoryRow({
  busy,
  category,
  onDelete,
  onRename,
  onShowTransactions,
  totals,
  transactionCount,
}: {
  busy: boolean;
  category: ExpenseCategory;
  onDelete: (category: ExpenseCategory) => Promise<boolean>;
  onRename: (category: ExpenseCategory, name: string) => Promise<boolean>;
  onShowTransactions: (category: ExpenseCategory) => void;
  /** Its transactions in the period shown, and their sum per currency. */
  totals: CategoryTotals;
  transactionCount: number;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RenameCategoryRow
        busy={busy}
        category={category}
        onCancel={() => setEditing(false)}
        onSave={async (name) => {
          if (await onRename(category, name)) setEditing(false);
        }}
      />
    );
  }
  async function remove() {
    if (await confirmCategoryDeletion(category)) void onDelete(category);
  }
  return (
    <ListRow
      className="financeCategory"
      items={[
        {
          icon: "list",
          id: "show-transactions",
          label: "Show transactions",
          onSelect: () => onShowTransactions(category),
        },
        {
          disabled: busy,
          icon: "edit",
          id: "rename",
          label: "Rename",
          onSelect: () => setEditing(true),
        },
        {
          disabled: busy,
          icon: "trash",
          id: "delete",
          label: "Delete",
          onSelect: () => void remove(),
        },
      ]}
      meta={countLabel(transactionCount, "transaction")}
      open={{ onClick: () => onShowTransactions(category) }}
      title={category.name}
    >
      {transactionCount > 0 && <CategoryTotal totals={totals} />}
    </ListRow>
  );
}

/**
 * A category's transactions summed as rows show amounts (spending negative),
 * one amount per currency (named by code, and wrapping onto their own lines
 * when the row is narrow); a currency that sums to zero shows only when
 * every one does.
 */
function CategoryTotal({ totals }: { totals: CategoryTotals }) {
  const shown = totals.filter(({ total }) => total !== 0);
  const amounts = shown.length ? shown : totals.slice(0, 1);
  return (
    <span
      className={cx(
        "financeAmount",
        amounts.length === 1 &&
          (amounts[0]?.total ?? 0) > 0 &&
          "financeAmountCredit",
      )}
    >
      {amounts.map(({ currencyCode, total }) => (
        <span key={currencyCode ?? ""}>
          {formatMoney(
            total,
            currencyCode,
            amounts.length > 1 ? "code" : "narrowSymbol",
          )}
        </span>
      ))}
    </span>
  );
}

function RenameCategoryRow({
  busy,
  category,
  onCancel,
  onSave,
}: {
  busy: boolean;
  category: ExpenseCategory;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  // The Rename button that had focus is gone; move focus to the field.
  useEffect(() => input.current?.select(), []);
  return (
    <li className="row">
      <form
        aria-label={`Rename ${category.name}`}
        className="financeCategoryRename"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(trimmed);
        }}
      >
        <Field className="financeCategoryRenameField" label="Category name">
          <input
            className="input inputSm"
            maxLength={financeLimits.categoryName}
            onChange={(event) => setName(event.target.value)}
            ref={input}
            required
            value={name}
          />
        </Field>
        <div className="rowActions">
          <Button onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!trimmed || trimmed === category.name}
            size="sm"
            type="submit"
            variant="primary"
          >
            Save
          </Button>
        </div>
      </form>
    </li>
  );
}

function confirmCategoryDeletion(category: ExpenseCategory) {
  return confirmDialog({
    confirmLabel: "Delete category",
    message: category.transactionCount
      ? `${countLabel(category.transactionCount, "transaction")} will become uncategorized.`
      : undefined,
    title: `Delete “${category.name}”?`,
    tone: "danger",
  });
}
