import {
  Badge,
  Button,
  Card,
  ContextMenu,
  cx,
  MenuButton,
} from "@balebase/ui/react";
import type {
  ExpenseCategory,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { countLabel, formatCalendarDate } from "../shared/labels";
import { formatMoney } from "./financeFormat";
import type { CreateRule } from "./financeRuleAction";
import {
  PayeeActionForm,
  type PayeeForm,
  uncategorizedValue,
} from "./PayeeActionForm";
import { type PayeeGroup, transactionTitle } from "./payeeGroups";

/** How the Transactions section lists what the filters match. */
export type TransactionView = "list" | "payees";

interface PayeeListActions {
  busy: boolean;
  categories: ExpenseCategory[];
  /** Every transaction the filters match; a payee's are those under its name. */
  matching: FinanceTransaction[];
  /** Gives transactions one category (null clears it); true once saved. */
  onCategorizeMany: (
    transactions: FinanceTransaction[],
    categoryId: string | null,
  ) => Promise<boolean>;
  /**
   * Creates a payee's rule as Finance's action (its busy state, messages,
   * and reload outlive this view); resolves whether it saved.
   */
  onCreateRule: CreateRule;
  onSelect: (name: string) => void;
}

/**
 * One row per payee; choosing one lists its transactions. Its menu, from the
 * menu button or a right-click, opens a form in the row to give all of the
 * payee's matching transactions a category or to create a rule for it.
 */
export function FinancePayeeList({
  busy,
  categories,
  matching,
  onCategorizeMany,
  onCreateRule,
  onSelect,
  payees,
}: PayeeListActions & { payees: PayeeGroup[] }) {
  const [forms, setForms] = useState<ReadonlyMap<string, PayeeForm>>(new Map());
  const current = useRef(forms);
  current.current = forms;
  const setForm = (payee: string, form: PayeeForm | undefined) =>
    setForms((all) => {
      const next = new Map(all);
      if (form) next.set(payee, form);
      else next.delete(payee);
      return next;
    });
  // A save closes its form once it lands, unless the form changed since.
  async function submit(payee: string) {
    const form = current.current.get(payee);
    if (!form) return;
    if (await save(payee, form)) {
      setForms((all) => {
        if (all.get(payee) !== form) return all;
        const next = new Map(all);
        next.delete(payee);
        return next;
      });
    }
  }
  function save(payee: string, input: PayeeForm) {
    if (input.action === "categorize") {
      return onCategorizeMany(
        matching.filter((row) => transactionTitle(row) === payee),
        input.categoryId === uncategorizedValue ? null : input.categoryId,
      );
    }
    return onCreateRule({
      applyToExisting: input.applyToExisting,
      categoryId: input.categoryId,
      payeeName: payee,
    });
  }
  return (
    <>
      {payees.length > 0 && (
        <Card className="financeListCard" flush>
          <ul aria-label="Payees" className="rowList financePayees">
            {payees.map((payee) => (
              <PayeeRow
                busy={busy}
                categories={categories}
                form={forms.get(payee.name)}
                key={payee.name}
                onForm={(form) => setForm(payee.name, form)}
                onSelect={onSelect}
                onSubmit={() => void submit(payee.name)}
                payee={payee}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function PayeeRow({
  busy,
  categories,
  form,
  onForm,
  onSelect,
  onSubmit,
  payee,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  form: PayeeForm | undefined;
  onForm: (form: PayeeForm | undefined) => void;
  onSelect: (name: string) => void;
  onSubmit: () => void;
  payee: PayeeGroup;
}) {
  // Closing the form removes the focused field: focus returns to the row's
  // menu button, which opened it.
  const actions = useRef<HTMLDivElement>(null);
  const hadForm = useRef(false);
  const open = Boolean(form);
  useEffect(() => {
    if (open) {
      hadForm.current = true;
      return;
    }
    if (!hadForm.current) return;
    hadForm.current = false;
    actions.current?.querySelector("button")?.focus();
  }, [open]);
  if (form) {
    return (
      <PayeeActionForm
        busy={busy}
        categories={categories}
        form={form}
        onCancel={() => onForm(undefined)}
        onChange={onForm}
        onSubmit={onSubmit}
        payee={payee}
      />
    );
  }
  const start = (action: PayeeForm["action"]) =>
    onForm({ action, applyToExisting: true, categoryId: "" });
  const label = `Actions for ${payee.name}`;
  // Both actions give a category, so they wait for one to exist.
  const items: ComponentProps<typeof ContextMenu>["items"][number][] =
    categories.length
      ? [
          {
            disabled: busy,
            icon: "list",
            id: "categorize",
            label: `Categorize ${countLabel(payee.count, "transaction")}…`,
            onSelect: () => start("categorize"),
          },
          {
            disabled: busy,
            icon: "layers",
            id: "create-rule",
            label: "Create rule…",
            onSelect: () => start("rule"),
          },
        ]
      : [];
  return (
    <ContextMenu items={items} label={label}>
      {(targetProps, menuButton) => (
        // The name's button covers the whole row, so any click there opens it.
        <li className="row rowInteractive financePayee" {...targetProps}>
          <div className="rowMain">
            <Button
              aria-label={`Show transactions for ${payee.name}`}
              className="rowTitle rowTarget financePayeeName"
              onClick={() => onSelect(payee.name)}
              variant="link"
            >
              {payee.name}
            </Button>
            <span className="rowMeta">
              {countLabel(payee.count, "transaction")} · Latest{" "}
              {formatCalendarDate(payee.latestDate)}
            </span>
          </div>
          {payee.pending > 0 && (
            <Badge tone="warning">{payee.pending} pending</Badge>
          )}
          <span
            className={cx(
              "financeAmount",
              payee.total !== null && payee.total > 0 && "financeAmountCredit",
            )}
          >
            {payee.total === null
              ? "Several currencies"
              : formatMoney(payee.total, payee.currencyCode)}
          </span>
          {items.length > 0 && (
            <div className="rowActions" ref={actions}>
              <MenuButton {...menuButton} label={label} />
            </div>
          )}
        </li>
      )}
    </ContextMenu>
  );
}

/** Switches the Transactions section between rows and payee totals. */
export function TransactionViewSwitch({
  onChange,
  view,
}: {
  onChange: (view: TransactionView) => void;
  view: TransactionView;
}) {
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Transaction view</legend>
      {(
        [
          ["list", "Transactions"],
          ["payees", "By payee"],
        ] as const
      ).map(([value, label]) => (
        <button
          aria-pressed={view === value}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}
