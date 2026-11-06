import {
  Badge,
  Button,
  Card,
  ContextMenu,
  cx,
  MenuButton,
  Toast,
} from "@balebase/ui/react";
import type {
  ExpenseCategory,
  FinanceTransaction,
} from "@balebase/validators/finance";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { countLabel, formatCalendarDate } from "../shared/labels";
import { formatMoney } from "./financeFormat";
import { useFinanceSave } from "./financeSave";
import {
  type PayeeAction,
  PayeeActionForm,
  type PayeeActionInput,
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
  /** Reloads Finance after a rule may have categorized transactions. */
  onReload: () => Promise<void>;
  /** A save was refused: access ended. */
  onRefused: (cause: unknown) => Promise<void>;
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
  onReload,
  onRefused,
  onSelect,
  payees,
}: PayeeListActions & { payees: PayeeGroup[] }) {
  const rules = useFinanceSave("Could not save the rule.", onReload, onRefused);
  async function submit(payee: string, input: PayeeActionInput) {
    if (input.action === "categorize") {
      return onCategorizeMany(
        matching.filter((row) => transactionTitle(row) === payee),
        input.categoryId,
      );
    }
    return rules.run(async () => {
      const { applied } = await api.finance.createCategorizationRule({
        applyToExisting: input.applyToExisting,
        categoryId: input.categoryId,
        payeeName: payee,
      });
      return input.applyToExisting
        ? `Added a rule for “${payee}” and categorized ${countLabel(applied, "transaction")}.`
        : `Added a rule for “${payee}”.`;
    });
  }
  return (
    <>
      {rules.error && <Toast tone="danger">{rules.error}</Toast>}
      {rules.notice && <Toast tone="success">{rules.notice}</Toast>}
      <Card className="financeListCard" flush>
        <ul aria-label="Payees" className="rowList financePayees">
          {payees.map((payee) => (
            <PayeeRow
              busy={busy || rules.busy}
              categories={categories}
              key={payee.name}
              onSelect={onSelect}
              onSubmit={(input) => submit(payee.name, input)}
              payee={payee}
            />
          ))}
        </ul>
      </Card>
    </>
  );
}

function PayeeRow({
  busy,
  categories,
  onSelect,
  onSubmit,
  payee,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  onSelect: (name: string) => void;
  onSubmit: (input: PayeeActionInput) => Promise<boolean>;
  payee: PayeeGroup;
}) {
  const [action, setAction] = useState<PayeeAction>();
  // Closing the form removes the focused field: focus returns to the row's
  // menu button, which opened it.
  const actions = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (action || !returnFocus.current) return;
    returnFocus.current = false;
    actions.current?.querySelector("button")?.focus();
  }, [action]);
  if (action) {
    return (
      <PayeeActionForm
        action={action}
        busy={busy}
        categories={categories}
        onClose={() => {
          returnFocus.current = true;
          setAction(undefined);
        }}
        onSubmit={onSubmit}
        payee={payee}
      />
    );
  }
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
            onSelect: () => setAction("categorize"),
          },
          {
            disabled: busy,
            icon: "layers",
            id: "create-rule",
            label: "Create rule…",
            onSelect: () => setAction("rule"),
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
