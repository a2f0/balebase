import {
  type EmployeeRequirementKind,
  isBackgroundCheck,
} from "@balebase/validators/employeeForms";
import type { Context } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  capabilityRequired,
  stillHasCapability,
  userHasCapability,
} from "../organizations/organizationGroups";
import { canManage, stillManages } from "../organizations/organizationMembers";

/**
 * Who handles a form or check requested of a person. Owners and admins
 * handle forms and credit checks. Background checks belong to members of a
 * group with the Background checks capability, such as the built-in HR group,
 * whatever their role: an owner outside such a group neither sees nor changes
 * them. The person a request is for reads their own in My documents.
 */
export interface RequirementAccess {
  backgroundChecks: boolean;
  forms: boolean;
}

const managerRequired = "Organization manager access required.";

export async function requirementAccess(
  context: Context<ApiEnv>,
): Promise<RequirementAccess> {
  return {
    backgroundChecks: await userHasCapability(
      context.env.DB,
      context.get("organizationId"),
      context.get("authSession").user.id,
      "background_checks",
    ),
    forms: canManage(context),
  };
}

export function handlesKind(
  access: RequirementAccess,
  kind: EmployeeRequirementKind,
) {
  return isBackgroundCheck(kind) ? access.backgroundChecks : access.forms;
}

/** Why someone who doesn't handle `kind` is refused. */
export function handlerRequired(kind: EmployeeRequirementKind) {
  return isBackgroundCheck(kind)
    ? capabilityRequired("background_checks")
    : managerRequired;
}

/**
 * Holds while the actor still handles requests of `kind`, read inside the
 * write's transaction, so access lost after the request began changes nothing.
 */
export function stillHandlesKind(
  organizationId: string,
  userId: string,
  kind: EmployeeRequirementKind,
) {
  return isBackgroundCheck(kind)
    ? stillHasCapability(organizationId, userId, "background_checks")
    : stillManages(organizationId, userId);
}

/**
 * `stillHandlesKind` for the `employee_requirements` row a write guards, by
 * the row's own kind.
 */
export function stillHandlesRequirement(
  organizationId: string,
  userId: string,
) {
  const checks = stillHasCapability(
    organizationId,
    userId,
    "background_checks",
  );
  const manages = stillManages(organizationId, userId);
  return {
    bindings: [...checks.bindings, ...manages.bindings],
    sql: `(CASE WHEN employee_requirements.kind = 'background_check'
      THEN ${checks.sql} ELSE ${manages.sql} END)`,
  };
}
