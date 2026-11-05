import { useCallback, useEffect, useState } from "react";
import { lockOfflineWorkspace } from "../offline/offlineStore";
import {
  createOrganizationSlug,
  resolveActiveOrganizationId,
  type WorkspaceOrganization,
} from "../organizations/organizationState";
import { api } from "../shared/apiClient";
import { authClient } from "../shared/authClient";

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
  // Whose list `organizations` is as read, not the empty stand-in after a
  // failure.
  const [listedFor, setListedFor] = useState<string>();
  const loadOrganizations = useCallback(async () => {
    setOrganizations(await api.organizationSettings.organizations());
  }, []);
  const signedInUserId = session?.user.id;
  useEffect(() => {
    setListedFor(undefined);
    if (!signedInUserId) {
      setOrganizations(undefined);
      return;
    }
    // A previous account's request, settling late, must not replace this
    // one's list.
    let current = true;
    api.organizationSettings.organizations().then(
      (listed) => {
        if (!current) return;
        setOrganizations(listed);
        setListedFor(signedInUserId);
      },
      () => {
        if (current) setOrganizations([]);
      },
    );
    return () => {
      current = false;
    };
  }, [signedInUserId]);
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
    /** Whether `organizations` is the signed-in person's list as read. */
    listed: Boolean(signedInUserId) && listedFor === signedInUserId,
    organizations: organizations ?? [],
    refresh,
    switchOrganization,
  };
}
