import { Button, Card, Toast } from "@balebase/ui/react";
import { Fragment } from "react";
import { useClipboard } from "./useClipboard";

export interface SourceField {
  label: string;
  value: string | null;
  /** Explains a value whose meaning is not obvious from the raw text. */
  hint?: string;
  /** Identifiers people paste into Plaid's dashboard or a support ticket. */
  copyable?: boolean;
}

/** Imported values shown unformatted, with copy buttons for identifiers. */
export function FinanceSourceFields({ fields }: { fields: SourceField[] }) {
  const { copy, notice } = useClipboard();
  return (
    <Card>
      {notice && <Toast tone={notice.tone}>{notice.message}</Toast>}
      <dl className="keyValue">
        {fields.map(({ copyable, hint, label, value }) => (
          <Fragment key={label}>
            <dt title={hint}>{label}</dt>
            {value === null ? (
              <dd className="textSubtle">Not provided</dd>
            ) : (
              <dd className="mono financeSourceValue">
                <span>{value}</span>
                {copyable && (
                  <Button
                    aria-label={`Copy ${label}`}
                    icon="copy"
                    iconOnly
                    onClick={() => void copy(value, `${label} copied.`)}
                    size="sm"
                    variant="ghost"
                  />
                )}
              </dd>
            )}
          </Fragment>
        ))}
      </dl>
    </Card>
  );
}
