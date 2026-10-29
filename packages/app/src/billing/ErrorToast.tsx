import { Toast } from "@balebase/ui/react";
import type { ErrorNotice } from "../shared/errors";
import { BillingLink } from "./BillingLink";

/** An error toast that links to Billing when an upgrade resolves the error. */
export function ErrorToast({
  error,
  onNavigate,
}: {
  error: ErrorNotice | undefined;
  onNavigate: (pathname: string) => void;
}) {
  if (!error) return null;
  return (
    <Toast
      actions={error.upgrade ? <BillingLink onNavigate={onNavigate} /> : null}
      tone="danger"
    >
      {error.message}
    </Toast>
  );
}
