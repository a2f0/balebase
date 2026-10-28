import { AppButtonLink } from "./AppLink";
import { billingPath } from "./workspacePaths";

/** Opens Billing in place; a modified click opens it in a new tab. */
export function BillingLink({
  onNavigate,
  variant = "secondary",
}: {
  onNavigate: (pathname: string) => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <AppButtonLink
      href={billingPath}
      onNavigate={onNavigate}
      size={variant === "primary" ? undefined : "sm"}
      variant={variant}
    >
      Go to Billing
    </AppButtonLink>
  );
}
