import { Button, Field, Select } from "@balebase/ui/react";
import type { ExpenseCategory } from "@balebase/validators/finance";
import { useEffect, useRef } from "react";
import { countLabel } from "../shared/labels";
import type { PayeeGroup } from "./payeeGroups";

/**
 * An open payee form and what it holds. It lives with the payee list, not
 * the row: categorizing can drop the row from the filters' list while it
 * saves, and a failed save brings the row back with the form as it was.
 */
export interface PayeeForm {
  action: "categorize" | "rule";
  applyToExisting: boolean;
  /** A category's ID, `uncategorizedValue` (categorize only), or "". */
  categoryId: string;
}

/** The select's value for clearing the category. */
export const uncategorizedValue = "uncategorized";

/**
 * A payee row's form, in place of the row: gives the payee's matching
 * transactions one category, or creates a rule for the payee.
 */
export function PayeeActionForm({
  busy,
  categories,
  form,
  onCancel,
  onChange,
  onSubmit,
  payee,
}: {
  busy: boolean;
  categories: ExpenseCategory[];
  form: PayeeForm;
  onCancel: () => void;
  onChange: (form: PayeeForm) => void;
  onSubmit: () => void;
  payee: PayeeGroup;
}) {
  const select = useRef<HTMLSelectElement>(null);
  // The menu that opened the form is gone; move focus to its field once it
  // can take it. A failed save can bring the form back while Finance is
  // still busy, so this waits for that too, unless focus went elsewhere.
  useEffect(() => {
    const active = document.activeElement;
    if (busy || (active && active !== document.body)) return;
    select.current?.focus();
  }, [busy]);
  const rule = form.action === "rule";
  return (
    <li className="row">
      <form
        aria-label={
          rule ? `Create a rule for ${payee.name}` : `Categorize ${payee.name}`
        }
        className="financePayeeAction"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
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
            onChange={(event) =>
              onChange({ ...form, categoryId: event.target.value })
            }
            ref={select}
            required
            value={form.categoryId}
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
              checked={form.applyToExisting}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...form, applyToExisting: event.target.checked })
              }
              type="checkbox"
            />
            Also categorize this payee's existing uncategorized transactions
          </label>
        )}
        <div className="rowActions">
          <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!form.categoryId}
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
