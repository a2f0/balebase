import { Button, Field, Select } from "@balebase/ui/react";
import type { ExpenseCategory } from "@balebase/validators/finance";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { countLabel } from "../shared/labels";
import type { PayeeGroup } from "./payeeGroups";

/** What a payee row's form does. */
export type PayeeAction = "categorize" | "rule";

export type PayeeActionInput =
  /** Every matching transaction under the payee; null clears the category. */
  | { action: "categorize"; categoryId: string | null }
  | { action: "rule"; applyToExisting: boolean; categoryId: string };

/** The select's value for clearing the category. */
const uncategorizedValue = "uncategorized";

/**
 * A payee row's form, in place of the row: gives the payee's matching
 * transactions one category, or creates a rule for the payee.
 */
export function PayeeActionForm({
  action,
  busy,
  categories,
  onClose,
  onSubmit,
  payee,
}: {
  action: PayeeAction;
  busy: boolean;
  categories: ExpenseCategory[];
  onClose: () => void;
  /** Resolves whether it saved; the form stays open with its values if not. */
  onSubmit: (input: PayeeActionInput) => Promise<boolean>;
  payee: PayeeGroup;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [applyToExisting, setApplyToExisting] = useState(true);
  const select = useRef<HTMLSelectElement>(null);
  // A save finishing after this form closed must not close what shows then.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    select.current?.focus();
    return () => {
      open.current = false;
    };
  }, []);
  const rule = action === "rule";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onSubmit(
      rule
        ? { action, applyToExisting, categoryId }
        : {
            action,
            categoryId: categoryId === uncategorizedValue ? null : categoryId,
          },
    );
    if (saved && open.current) onClose();
  }
  return (
    <li className="row">
      <form
        aria-label={
          rule ? `Create a rule for ${payee.name}` : `Categorize ${payee.name}`
        }
        className="financePayeeAction"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label={
            rule
              ? `Rule for “${payee.name}”: category`
              : `Category for ${countLabel(payee.count, "transaction")} from “${payee.name}”`
          }
        >
          <Select
            disabled={busy}
            onChange={(event) => setCategoryId(event.target.value)}
            ref={select}
            required
            value={categoryId}
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
            {!rule && <option value={uncategorizedValue}>Uncategorized</option>}
          </Select>
        </Field>
        {rule && (
          <label className="check">
            <input
              checked={applyToExisting}
              disabled={busy}
              onChange={(event) => setApplyToExisting(event.target.checked)}
              type="checkbox"
            />
            Also categorize this payee's existing uncategorized transactions
          </label>
        )}
        <div className="rowActions">
          <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!categoryId}
            size="sm"
            type="submit"
            variant="primary"
          >
            {rule ? "Create rule" : "Categorize"}
          </Button>
        </div>
      </form>
    </li>
  );
}
