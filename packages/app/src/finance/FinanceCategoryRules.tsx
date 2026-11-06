import {
  Banner,
  Button,
  Card,
  ContextMenu,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  MenuButton,
  PageSection,
  Select,
} from "@balebase/ui/react";
import type {
  CategorizationRule,
  ExpenseCategory,
} from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import {
  type ComponentProps,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useLoad } from "../shared/useLoad";
import { rulesChanged } from "./financeRuleAction";
import type { RunChange } from "./financeSave";
import { refused } from "./transactionCache";

/**
 * Categorization rules: each gives one payee's transactions (those shown
 * under exactly its name) an expense category when they are imported, and
 * can fill the payee's existing uncategorized transactions.
 */
export function FinanceCategoryRules({
  busy,
  categories,
  onRefused,
  run,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  /** Loading the rules was refused: access ended. */
  onRefused: (cause: unknown) => Promise<void>;
  run: RunChange;
}) {
  const refusedRef = useRef(onRefused);
  refusedRef.current = onRefused;
  // Only the newest load, while mounted, may report a refusal: an older or
  // abandoned one must not clear what Finance shows now.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      return (await api.finance.categorizationRules()).rules;
    } catch (cause) {
      if (refused(cause) && mounted.current && request === latest.current)
        await refusedRef.current(cause);
      throw cause;
    }
  }, []);
  const rules = useLoad(load, "Could not load the rules.");
  useCategoryRefresh(categories, rules.reload);
  useEffect(() => {
    const reload = () => void rules.reload();
    rulesChanged.addEventListener("change", reload);
    return () => rulesChanged.removeEventListener("change", reload);
  }, [rules.reload]);
  const change: RunChange = (work) =>
    run(async () => {
      const message = await work();
      await rules.reload();
      return message;
    });
  return (
    <>
      {categories.length > 0 && (
        <AddRuleForm busy={busy} categories={categories} run={change} />
      )}
      <PageSection
        actions={
          rules.data?.length ? (
            <span className="sectionCount">
              {countLabel(rules.data.length, "rule")}
            </span>
          ) : undefined
        }
        description="New transactions from a payee get its rule's category when they are imported. Rules fill only uncategorized transactions; they never change a category someone chose."
        title="Categorization rules"
      >
        {rules.error && (
          <Banner
            actions={
              <Button onClick={() => void rules.reload()} size="sm">
                Retry
              </Button>
            }
            tone="danger"
          >
            {rules.error}
          </Banner>
        )}
        <RuleList
          busy={busy}
          categories={categories}
          rules={rules.data}
          run={change}
        />
      </PageSection>
    </>
  );
}

/**
 * Reloads the rules after a category is renamed or deleted (deleting one
 * deletes its rules), so none shows a stale name or stays actionable.
 */
function useCategoryRefresh(
  categories: ExpenseCategory[],
  reload: () => Promise<boolean>,
) {
  const key = JSON.stringify(categories.map(({ id, name }) => [id, name]));
  const first = useRef(key);
  useEffect(() => {
    if (key !== first.current) {
      first.current = key;
      void reload();
    }
  }, [key, reload]);
}

/**
 * `?payee=<name>` (Create rule on a transaction) fills the payee once, then
 * leaves the address, so reloading or sharing it opens an empty form.
 */
function requestedPayee() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const payee = params.get("payee");
  if (payee === null) return "";
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname,
  );
  return payee;
}

function AddRuleForm({
  busy,
  categories,
  run,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  run: RunChange;
}) {
  const [requested] = useState(requestedPayee);
  const [payeeName, setPayeeName] = useState(requested);
  const [categoryId, setCategoryId] = useState("");
  const [applyToExisting, setApplyToExisting] = useState(true);
  // The fields hold still while any change saves, and a save clears only
  // the values it sent.
  const current = useRef({ categoryId, payeeName });
  current.current = { categoryId, payeeName };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sent = { categoryId, payeeName };
    const saved = await run(async () => {
      const { applied } = await api.finance.createCategorizationRule({
        applyToExisting,
        categoryId,
        payeeName,
      });
      return applyToExisting
        ? `Added a rule for “${payeeName}” and categorized ${countLabel(applied, "transaction")}.`
        : `Added a rule for “${payeeName}”.`;
    });
    const now = current.current;
    if (
      saved &&
      now.payeeName === sent.payeeName &&
      now.categoryId === sent.categoryId
    ) {
      setPayeeName("");
      setCategoryId("");
    }
  }
  return (
    <Card
      description="Use the payee's name exactly as transactions show it, such as Shell. Choose Create rule on a transaction to start from its name."
      footer={
        <Button
          busy={busy}
          disabled={!payeeName || !categoryId}
          icon="add"
          type="submit"
          variant="primary"
        >
          Add rule
        </Button>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a rule"
    >
      <div className="formGrid">
        <Field label="Payee name">
          <input
            className="input"
            disabled={busy}
            maxLength={financeLimits.payeeName}
            onChange={(event) => setPayeeName(event.target.value)}
            placeholder="Shell"
            required
            value={payeeName}
          />
        </Field>
        <Field label="Category">
          <Select
            // Arriving from a transaction, the payee is filled in already.
            autoFocus={Boolean(requested)}
            disabled={busy}
            onChange={(event) => setCategoryId(event.target.value)}
            required
            value={categoryId}
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="check">
        <input
          checked={applyToExisting}
          disabled={busy}
          onChange={(event) => setApplyToExisting(event.target.checked)}
          type="checkbox"
        />
        Also categorize this payee's existing uncategorized transactions
      </label>
    </Card>
  );
}

function RuleList({
  busy,
  categories,
  rules,
  run,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  rules: CategorizationRule[] | undefined;
  run: RunChange;
}) {
  if (!rules) return <LoadingState label="Loading rules…" />;
  if (!rules.length) {
    return (
      <EmptyState icon="layers" title="No categorization rules yet">
        Add one above, or choose Create rule on a transaction.
      </EmptyState>
    );
  }
  return (
    <Card flush>
      <ul aria-label="Categorization rules" className="rowList">
        {rules.map((rule) => (
          <RuleRow
            busy={busy}
            categories={categories}
            key={rule.id}
            rule={rule}
            run={run}
          />
        ))}
      </ul>
    </Card>
  );
}

/**
 * A rule. Its menu, from the menu button or a right-click anywhere on the
 * row, edits it, fills its payee's uncategorized transactions, or deletes it.
 */
function RuleRow({
  busy,
  categories,
  rule,
  run,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  rule: CategorizationRule;
  run: RunChange;
}) {
  const [editing, setEditing] = useState(false);
  // Closing the editor removes the focused form: focus returns to the
  // row's menu button, which opened it.
  const actions = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    actions.current?.querySelector("button")?.focus();
  }, [editing]);
  if (editing) {
    return (
      <EditRuleRow
        busy={busy}
        categories={categories}
        onClose={() => {
          returnFocus.current = true;
          setEditing(false);
        }}
        rule={rule}
        run={run}
      />
    );
  }
  const apply = () =>
    run(async () => {
      const { applied } = await api.finance.applyCategorizationRule(rule.id);
      return `Categorized ${countLabel(applied, "transaction")} from “${rule.payeeName}”.`;
    });
  async function remove() {
    const confirmed = await confirmDialog({
      confirmLabel: "Delete rule",
      message:
        "Transactions it already categorized keep their category; new ones from this payee stay uncategorized.",
      title: `Delete the rule for “${rule.payeeName}”?`,
      tone: "danger",
    });
    if (!confirmed) return;
    await run(async () => {
      await api.finance.deleteCategorizationRule(rule.id);
      return `Deleted the rule for “${rule.payeeName}”.`;
    });
  }
  const label = `Actions for the rule for ${rule.payeeName}`;
  const items: ComponentProps<typeof ContextMenu>["items"][number][] = [
    {
      disabled: busy,
      icon: "edit",
      id: "edit",
      label: "Edit",
      onSelect: () => setEditing(true),
    },
  ];
  if (rule.uncategorizedCount > 0) {
    items.push({
      disabled: busy,
      icon: "layers",
      id: "apply",
      label: `Categorize ${countLabel(rule.uncategorizedCount, "transaction")}`,
      onSelect: () => void apply(),
    });
  }
  items.push({
    disabled: busy,
    icon: "trash",
    id: "delete",
    label: "Delete",
    onSelect: () => void remove(),
  });
  return (
    <ContextMenu items={items} label={label}>
      {(targetProps, menuButton) => (
        <li className="row" {...targetProps}>
          <div className="rowMain">
            <span className="rowTitle">{rule.payeeName}</span>
            <span className="rowMeta">
              {rule.category.name}
              {rule.uncategorizedCount > 0 &&
                ` · ${countLabel(rule.uncategorizedCount, "uncategorized transaction")}`}
              {rule.owner && ` · Created by ${rule.owner.name}`}
            </span>
          </div>
          <div className="rowActions" ref={actions}>
            <MenuButton {...menuButton} label={label} />
          </div>
        </li>
      )}
    </ContextMenu>
  );
}

/**
 * Edits a rule's payee and category in place. Saving categorizes nothing:
 * the row then shows the new payee's uncategorized transactions to fill.
 */
function EditRuleRow({
  busy,
  categories,
  onClose,
  rule,
  run,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  onClose: () => void;
  rule: CategorizationRule;
  run: RunChange;
}) {
  const [payeeName, setPayeeName] = useState(rule.payeeName);
  const [categoryId, setCategoryId] = useState(rule.category.id);
  const input = useRef<HTMLInputElement>(null);
  // A save finishing after this form closed (the rules went with access, or
  // the page changed) must not close whatever shows by then.
  const open = useRef(true);
  // The menu that opened this form is gone; move focus to the payee.
  useEffect(() => {
    open.current = true;
    input.current?.focus();
    input.current?.select();
    return () => {
      open.current = false;
    };
  }, []);
  const unchanged =
    payeeName === rule.payeeName && categoryId === rule.category.id;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await run(async () => {
      await api.finance.updateCategorizationRule(rule.id, {
        categoryId,
        payeeName,
      });
      return `Saved the rule for “${payeeName}”.`;
    });
    if (saved && open.current) onClose();
  }
  return (
    <li className="row">
      <form
        aria-label={`Edit the rule for ${rule.payeeName}`}
        className="financeRuleEdit"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="Payee name">
          <input
            className="input inputSm"
            disabled={busy}
            maxLength={financeLimits.payeeName}
            onChange={(event) => setPayeeName(event.target.value)}
            ref={input}
            required
            value={payeeName}
          />
        </Field>
        <Field label="Category">
          <Select
            disabled={busy}
            onChange={(event) => setCategoryId(event.target.value)}
            required
            value={categoryId}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rowActions">
          <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!payeeName || unchanged}
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
