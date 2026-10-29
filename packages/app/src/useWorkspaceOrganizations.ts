import { useCallback, useEffect, useState } from "react";
import { lockOfflineWorkspace } from "./offlineStore";
import {
  createOrganizationSlug,
  resolveActiveOrganizationId,
  type WorkspaceOrganization,
} from "./organizationState";
import { api } from "./shared/apiClient";
import { authClient } from "./shared/authClient";

export interface OrganizationSession {
  session: { activeOrganizationId?: string | null | undefined };
  user: {
    defaultOrganizationId?: string | null | undefined;
    id: string;
  };
}

export function useWorkspaceOrganizations(
  session: OrganizationSession | null | undefined,
  refetchSession: () => Promise<unknown>,
) {
  const [organizations, setOrganizations] = useState<
    WorkspaceOrganization[] | undefined
  >();
  const loadOrganizations = useCallback(async () => {
    setOrganizations(await api.organizationSettings.organizations());
  }, []);
  const signedInUserId = session?.user.id;
  useEffect(() => {
    if (!signedInUserId) {
      setOrganizations(undefined);
      return;
    }
    void loadOrganizations().catch(() => setOrganizations([]));
  }, [loadOrganizations, signedInUserId]);
  const activeOrganizationId = organizations
    ? resolveActiveOrganizationId(
        session?.session.activeOrganizationId,
        session?.user.defaultOrganizationId,
        organizations,
      )
    : (session?.session.activeOrganizationId ??
      session?.user.defaultOrganizationId ??
      undefined);
  const createOrganization = async (name: string) => {
    const result = await authClient.organization.create({
      name,
      slug: createOrganizationSlug(name, crypto.randomUUID()),
    });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not create this organization.",
      );
    }
    await loadOrganizations();
    await refetchSession();
  };
  const switchOrganization = async (organizationId: string) => {
    lockOfflineWorkspace();
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not switch organizations.",
      );
    }
    lockOfflineWorkspace();
    await refetchSession();
  };
  const refresh = async () => {
    await loadOrganizations();
    await refetchSession();
  };
  return {
    activeOrganizationId,
    createOrganization,
    isPending: organizations === undefined,
    organizations: organizations ?? [],
    refresh,
    switchOrganization,
  };
}
