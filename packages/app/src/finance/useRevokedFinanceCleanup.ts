import { useEffect } from "react";
import {
  type CacheScope,
  clearFormerOrganizations,
  clearScopeTransactions,
} from "./transactionCache";

interface FinanceAccess {
  can: (capability: "finance") => boolean;
  confirmed: boolean;
}

/**
 * The saved transactions to clear: a person's in an organization whose
 * access was read and lacks Finance. Not when access could not be read.
 */
export function revokedFinanceScope(
  userId: string | undefined,
  organizationId: string | undefined,
  access: FinanceAccess,
): CacheScope | undefined {
  if (!userId || !organizationId || !access.confirmed) return undefined;
  return access.can("finance") ? undefined : { organizationId, userId };
}

interface Workspace {
  activeOrganizationId: string | undefined;
  listed: boolean;
  organizations: { id: string }[];
}

/**
 * Clears saved transactions once access lacks Finance, and those of
 * organizations the person has left. Finance itself never mounts for either,
 * so its own refusal handling cannot run.
 */
export function useRevokedFinanceCleanup(
  userId: string | undefined,
  workspace: Workspace,
  access: FinanceAccess,
) {
  const memberships = workspace.listed
    ? workspace.organizations.map(({ id }) => id).sort()
    : undefined;
  const membershipKey = memberships && JSON.stringify(memberships);
  useEffect(() => {
    if (!userId || !membershipKey) return;
    void clearFormerOrganizations(userId, JSON.parse(membershipKey)).catch(
      () => {
        // Retried on the next load; nothing to show for it here.
      },
    );
  }, [membershipKey, userId]);
  const scope = revokedFinanceScope(
    userId,
    workspace.activeOrganizationId,
    access,
  );
  const revokedUser = scope?.userId;
  const revokedOrganization = scope?.organizationId;
  useEffect(() => {
    if (!revokedUser || !revokedOrganization) return;
    void clearScopeTransactions({
      organizationId: revokedOrganization,
      userId: revokedUser,
    }).catch(() => {
      // Retried on the next load; nothing to show for it here.
    });
  }, [revokedOrganization, revokedUser]);
}
