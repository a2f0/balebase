import { Field, Select } from "@balebase/ui/react";
import {
  type FinanceRuleMatchType,
  financeRuleMatchTypes,
} from "@balebase/validators/rules";

export const ruleMatchTypeLabels: Record<FinanceRuleMatchType, string> = {
  exact: "Exact match",
  startsWith: "Starts with",
  contains: "Contains",
};

export function RuleMatchTypeField({
  busy,
  onChange,
  value,
}: {
  busy: boolean;
  onChange: (value: FinanceRuleMatchType) => void;
  value: FinanceRuleMatchType;
}) {
  return (
    <Field label="Match type">
      <Select
        disabled={busy}
        onChange={(event) =>
          onChange(event.target.value as FinanceRuleMatchType)
        }
        value={value}
      >
        {financeRuleMatchTypes.map((type) => (
          <option key={type} value={type}>
            {ruleMatchTypeLabels[type]}
          </option>
        ))}
      </Select>
    </Field>
  );
}
