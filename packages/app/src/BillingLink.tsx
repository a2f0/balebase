import { ButtonLink } from "@balebase/ui/react";
import { handleNavigation } from "./workspacePaths";

export const billingPath = "/organization/billing";

/** Opens Billing in place; a modified click opens it in a new tab. */
export function BillingLink({
  onNavigate,
  variant = "secondary",
}: {
  onNavigate: (pathname: string) => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <ButtonLink
      href={billingPath}
      onClick={(event) => handleNavigation(event, billingPath, onNavigate)}
      size={variant === "primary" ? undefined : "sm"}
      variant={variant}
    >
      Go to Billing
    </ButtonLink>
  );
}
