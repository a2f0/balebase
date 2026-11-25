import type { OrganizationCapability } from "@balebase/validators/organizationGroups";
import { capabilityForPath } from "./workspacePaths";

/** What the person can tell about their access to a page. */
interface CapabilityAccess {
  can: (capability: OrganizationCapability) => boolean;
  /** Whether `can` is the server's answer rather than a failure to read it. */
  confirmed: boolean;
  paidFeaturesEnabled: boolean;
  /** A seat or two-factor requirement shows its own screen first. */
  requirementPending: boolean;
}

/** Why a page that needs a capability is closed to someone, if it is. */
export type CapabilityGate =
  | { reason: "paidFeaturesDisabled" }
  | { message: string; reason: "notInGroup" };

/** What someone outside every group granting a page's capability reads. */
const denials: Record<OrganizationCapability, string> = {
  background_checks:
    "Background checks group membership is required. An owner or admin can add you to a group with Background checks access, such as HR.",
  finance: "Finance group membership is required.",
};

/**
 * Whether `pathname`'s capability keeps the person out. Finance is a paid
 * feature, so with paid features off its page says that instead; background
 * checks are read without paid features.
 */
export function capabilityGate(
  pathname: string,
  access: CapabilityAccess,
): CapabilityGate | undefined {
  const capability = capabilityForPath(pathname);
  if (!capability || access.requirementPending || access.can(capability))
    return undefined;
  if (
    capability === "finance" &&
    access.confirmed &&
    !access.paidFeaturesEnabled
  )
    return { reason: "paidFeaturesDisabled" };
  return { message: denials[capability], reason: "notInGroup" };
}
