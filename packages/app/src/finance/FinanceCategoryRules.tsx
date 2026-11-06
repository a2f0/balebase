import {
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  PageSection,
  Select,
} from "@balebase/ui/react";
import type {
  CategorizationRule,
  ExpenseCategory,
} from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useLoad } from "../shared/useLoad";
import { refused } from "./transactionCache";

/** Runs a rule change; resolves a success message, or throws its failure. */
type RunChange = (change: () => Promise<string>) => Promise<boolean>;

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
  categories: ExpenseCategory[] | undefined;
  /** Loading the rules was refused: access ended. */
  onRefused: (cause: unknown) => Promise<void>;
  run: RunChange;
}) {
  const refusedRef = useRef(onRefused);
  refusedRef.current = onRefused;
  const load = useCallback(async () => {
    try {
      return (await api.finance.categorizationRules()).rules;
    } catch (cause) {
      if (refused(cause)) await refusedRef.current(cause);
      throw cause;
    }
  }, []);
  const rules = useLoad(load, "Could not load the rules.");
  const change: RunChange = (work) =>
    run(async () => {
      const message = await work();
      await rules.reload();
      return message;
    });
  return (
    <>
      {categories && categories.length > 0 && (
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
        <RuleList busy={busy} rules={rules.data} run={change} />
      </PageSection>
    </>
  );
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    if (saved) {
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
  rules,
  run,
}: {
  busy: boolean;
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
          <RuleRow busy={busy} key={rule.id} rule={rule} run={run} />
        ))}
      </ul>
    </Card>
  );
}

function RuleRow({
  busy,
  rule,
  run,
}: {
  busy: boolean;
  rule: CategorizationRule;
  run: RunChange;
}) {
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
  return (
    <li className="row">
      <div className="rowMain">
        <span className="rowTitle">{rule.payeeName}</span>
        <span className="rowMeta">
          {rule.category.name}
          {rule.uncategorizedCount > 0 &&
            ` · ${countLabel(rule.uncategorizedCount, "uncategorized transaction")}`}
        </span>
      </div>
      <div className="rowActions">
        {rule.uncategorizedCount > 0 && (
          <Button
            disabled={busy}
            icon="layers"
            onClick={() => void apply()}
            size="sm"
          >
            Categorize {rule.uncategorizedCount.toLocaleString()}
          </Button>
        )}
        <Button
          aria-label={`Delete the rule for ${rule.payeeName}`}
          disabled={busy}
          icon="trash"
          onClick={() => void remove()}
          size="sm"
          variant="danger"
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
