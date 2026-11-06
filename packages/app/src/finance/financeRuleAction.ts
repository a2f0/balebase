import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";

/** A payee's new categorization rule, and whether it fills existing rows. */
interface NewRule {
  applyToExisting: boolean;
  categoryId: string;
  payeeName: string;
}

/** Creates a payee's rule; resolves whether it saved. */
export type CreateRule = (input: NewRule) => Promise<boolean>;

/**
 * Creates rules as one of Finance's actions (`save`), so its busy state,
 * messages, and reload outlive the view that asked.
 */
export function createRuleAction(
  save: (action: () => Promise<string>) => Promise<boolean>,
): CreateRule {
  return (input) =>
    save(async () => {
      const { applied } = await api.finance.createCategorizationRule(input);
      return input.applyToExisting
        ? `Added a rule for “${input.payeeName}” and categorized ${countLabel(applied, "transaction")}.`
        : `Added a rule for “${input.payeeName}”.`;
    });
}
