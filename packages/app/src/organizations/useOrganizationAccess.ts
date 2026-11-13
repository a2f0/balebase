import { ApiError } from "@balebase/api-client";
import type { OrganizationCapability } from "@balebase/validators/organizationGroups";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import {
  type OrganizationSeatRequirement,
  type OrganizationTwoFactorRequirement,
  seatRequirementFrom,
  twoFactorRequirementFrom,
} from "./organizationAccessErrors";

interface AccessState {
  capabilities: OrganizationCapability[];
  /**
   * Whether the capabilities are the server's answer: read, or refused
   * (signed out, no longer a member), rather than unknown after a failure.
   */
  confirmed: boolean;
  memberRole: string;
  organizationId: string;
  ownerCount: number;
  paidFeaturesEnabled: boolean;
  userId: string;
}

interface RequirementState {
  organizationId: string;
  seat: OrganizationSeatRequirement | undefined;
  twoFactor: OrganizationTwoFactorRequirement | undefined;
  userId: string;
}

export function useOrganizationAccess(
  userId: string | undefined,
  organizationId: string | undefined,
) {
  const requestSequence = useRef(0);
  const [state, setState] = useState<AccessState>();
  const [loadError, setLoadError] = useState<string>();
  const [requirementState, setRequirementState] = useState<RequirementState>();
  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!userId || !organizationId) {
      setState(undefined);
      setLoadError(undefined);
      setRequirementState(undefined);
      return;
    }
    setLoadError(undefined);
    try {
      const result = await api.organizationGroups.access();
      if (requestId !== requestSequence.current) return;
      setRequirementState(undefined);
      setState({
        capabilities: result.capabilities,
        confirmed: true,
        memberRole: result.memberRole,
        organizationId,
        ownerCount: result.ownerCount,
        paidFeaturesEnabled: result.paidFeaturesEnabled,
        userId,
      });
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      const twoFactor = twoFactorRequirementFrom(cause);
      const seat = seatRequirementFrom(cause);
      setRequirementState(
        twoFactor || seat
          ? { organizationId, seat, twoFactor, userId }
          : undefined,
      );
      setLoadError(errorMessage(cause, "Could not load organization access."));
      setState({
        capabilities: [],
        confirmed:
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403),
        memberRole: "",
        organizationId,
        ownerCount: 0,
        paidFeaturesEnabled: false,
        userId,
      });
    }
  }, [organizationId, userId]);
  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);
  const current =
    state?.organizationId === organizationId && state?.userId === userId
      ? state
      : undefined;
  const currentRequirement =
    requirementState &&
    requirementState.organizationId === organizationId &&
    requirementState.userId === userId
      ? requirementState
      : undefined;
  return {
    can: (capability: OrganizationCapability) =>
      (capability !== "finance" || current?.paidFeaturesEnabled === true) &&
      (current?.capabilities.includes(capability) ?? false),
    // Pending only until this user and organization first resolve; later
    // refreshes keep the current screen instead of blanking the workspace.
    isPending: Boolean(userId && organizationId && !current),
    /** Whether `can` reflects the server's answer, not a failure to read it. */
    confirmed: current?.confirmed ?? false,
    loadError,
    memberRole: current?.memberRole || undefined,
    ownerCount: current?.ownerCount ?? 0,
    paidFeaturesEnabled: current?.paidFeaturesEnabled === true,
    refresh,
    seatRequirement: currentRequirement?.seat,
    twoFactorRequirement: currentRequirement?.twoFactor,
  };
}
