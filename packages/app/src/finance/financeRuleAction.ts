import type { FinanceRuleMatchType } from "@balebase/validators/rules";
import { balebase } from "../balebase";
import { countLabel } from "../shared/labels";

/** A payee's new categorization rule, and whether it fills existing rows. */
interface NewRule {
  applyToExisting: boolean;
  categoryId: string;
  matchType: FinanceRuleMatchType;
  payeeName: string;
}

/**
 * Announces a rule created outside the rule list (a payee's form), so a
 * mounted list, such as Rules opened while the save ran, loads it.
 */
export const rulesChanged = new EventTarget();

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
      const { applied } =
        await balebase().api.finance.createCategorizationRule(input);
      rulesChanged.dispatchEvent(new Event("change"));
      return input.applyToExisting
        ? `Added a rule for “${input.payeeName}” and categorized ${countLabel(applied, "transaction")}.`
        : `Added a rule for “${input.payeeName}”.`;
    });
}
