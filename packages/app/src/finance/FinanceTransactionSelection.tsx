import { Button, Select } from "@balebase/ui/react";
import type {
  ExpenseCategory,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { useEffect, useRef, useState } from "react";

/** The bulk category menu's value for clearing the category. */
const uncategorizedValue = "uncategorized";

export interface TransactionSelection {
  clear: () => void;
  isSelected: (transactionId: string) => boolean;
  /** Selected transactions among those shown, in list order. */
  selected: FinanceTransaction[];
  /** Flips one row; with `range`, every row from the last one flipped too. */
  toggle: (transactionId: string, range: boolean) => void;
  /** Clears any selection, or selects every shown row when none is. */
  toggleAll: () => void;
  total: number;
}

const nothingChosen: ReadonlySet<string> = new Set();

interface SelectionState {
  /** The row a Shift-click range starts from. */
  anchor: string | undefined;
  ids: ReadonlySet<string>;
  /** The filters the selection was made under. */
  key: string;
}

/**
 * Checkbox selection over the shown transactions. Rows that leave the list
 * (a category view they no longer match) drop out of it, and a new
 * `resetKey` (the effective filters, however they changed) starts afresh.
 */
export function useTransactionSelection(
  transactions: FinanceTransaction[] | undefined,
  resetKey: string,
): TransactionSelection {
  const [state, setState] = useState<SelectionState>(() => ({
    anchor: undefined,
    ids: nothingChosen,
    key: resetKey,
  }));
  // New filters drop the selection itself, so returning to the old ones
  // does not bring it back.
  const current: SelectionState =
    state.key === resetKey
      ? state
      : { anchor: undefined, ids: nothingChosen, key: resetKey };
  if (current !== state) setState(current);
  const chosen = current.ids;
  const setChosen = (ids: ReadonlySet<string>, anchor = current.anchor) =>
    setState({ anchor, ids, key: resetKey });
  const shown = transactions ?? [];
  const selected = shown.filter(({ id }) => chosen.has(id));

  function toggle(transactionId: string, range: boolean) {
    const index = shown.findIndex(({ id }) => id === transactionId);
    const from = range
      ? shown.findIndex(({ id }) => id === current.anchor)
      : -1;
    const ids =
      from < 0
        ? [transactionId]
        : shown
            .slice(Math.min(from, index), Math.max(from, index) + 1)
            .map(({ id }) => id);
    const on = !chosen.has(transactionId);
    const next = new Set(selected.map(({ id }) => id));
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setChosen(next, transactionId);
  }

  return {
    clear: () => setChosen(new Set()),
    isSelected: (transactionId) => chosen.has(transactionId),
    selected,
    toggle,
    // As in Gmail, a partial selection clears; an empty one selects all.
    toggleAll: () =>
      setChosen(
        selected.length ? new Set() : new Set(shown.map(({ id }) => id)),
      ),
    total: shown.length,
  };
}

/**
 * The toolbar above the list: select every shown transaction, then give the
 * selection one expense category.
 */
export function TransactionSelectionBar({
  busy,
  categories,
  onCategorize,
  selection,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  onCategorize: (
    transactions: FinanceTransaction[],
    categoryId: string | null,
  ) => Promise<boolean>;
  selection: TransactionSelection;
}) {
  const [applying, setApplying] = useState(false);
  const count = selection.selected.length;

  async function apply(value: string) {
    if (!value) return;
    setApplying(true);
    try {
      const categoryId = value === uncategorizedValue ? null : value;
      if (await onCategorize(selection.selected, categoryId)) {
        selection.clear();
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="financeSelectionBar">
      <SelectAllCheckbox
        count={count}
        disabled={busy || applying}
        onToggle={selection.toggleAll}
        total={selection.total}
      />
      <span className="financeSelectionCount" aria-live="polite">
        {count
          ? `${count} selected`
          : "Select transactions to categorize them together"}
      </span>
      {count > 0 && (
        <div className="cluster financeSelectionActions">
          <Select
            aria-label="Category for selected transactions"
            className="inputSm"
            disabled={busy || applying}
            onChange={(event) => void apply(event.target.value)}
            value=""
          >
            <option disabled value="">
              {applying ? "Categorizing…" : "Set category…"}
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
            <option value={uncategorizedValue}>Uncategorized</option>
          </Select>
          <Button
            disabled={applying}
            icon="close"
            onClick={selection.clear}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

/** Checked when every shown row is, mixed when only some are. */
function SelectAllCheckbox({
  count,
  disabled,
  onToggle,
  total,
}: {
  count: number;
  disabled: boolean;
  onToggle: () => void;
  total: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const all = total > 0 && count === total;
  const some = count > 0 && !all;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <label className="check financeSelectCheck">
      <input
        aria-label={count ? "Clear selection" : "Select all shown transactions"}
        checked={all}
        disabled={disabled || !total}
        onChange={onToggle}
        ref={ref}
        type="checkbox"
      />
    </label>
  );
}

/** A row's checkbox; shift-click selects the range from the last one. */
export function TransactionSelectCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: (range: boolean) => void;
}) {
  return (
    <label className="check financeSelectCheck financeTransactionSelect">
      <input
        aria-label={label}
        checked={checked}
        disabled={disabled}
        // React reports a checkbox change from its click, which has shiftKey.
        onChange={(event) =>
          onToggle(
            "shiftKey" in event.nativeEvent &&
              event.nativeEvent.shiftKey === true,
          )
        }
        type="checkbox"
      />
    </label>
  );
}
