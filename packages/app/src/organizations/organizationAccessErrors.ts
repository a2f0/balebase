import { ApiError } from "@balebase/api-client";

export type OrganizationTwoFactorRequirement = "setup" | "verification";
/** Why a Free organization has no seat for this user: an owner can upgrade. */
export type OrganizationSeatRequirement = "upgrade" | "ask-owner";

export function twoFactorRequirementFrom(
  cause: unknown,
): OrganizationTwoFactorRequirement | undefined {
  if (!(cause instanceof ApiError)) return undefined;
  if (cause.code === "TWO_FACTOR_SETUP_REQUIRED") return "setup";
  if (cause.code === "TWO_FACTOR_VERIFICATION_REQUIRED") {
    return "verification";
  }
  return undefined;
}

export function seatRequirementFrom(
  cause: unknown,
): OrganizationSeatRequirement | undefined {
  if (!(cause instanceof ApiError)) return undefined;
  if (cause.code === "UPGRADE_REQUIRED") return "upgrade";
  if (cause.code === "SEAT_UNAVAILABLE") return "ask-owner";
  return undefined;
}
