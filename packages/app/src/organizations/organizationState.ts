export interface WorkspaceOrganization {
  id: string;
  name: string;
}

const organizationInvitationRoles = ["member", "admin", "owner"] as const;

export type OrganizationInvitationRole =
  (typeof organizationInvitationRoles)[number];

export function createOrganizationSlug(name: string, suffix: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const safeSuffix = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return `${base || "organization"}-${safeSuffix}`;
}

export function resolveActiveOrganizationId(
  activeOrganizationId: string | null | undefined,
  defaultOrganizationId: string | null | undefined,
  organizations: WorkspaceOrganization[],
) {
  if (
    activeOrganizationId &&
    organizations.some(({ id }) => id === activeOrganizationId)
  ) {
    return activeOrganizationId;
  }
  if (
    defaultOrganizationId &&
    organizations.some(({ id }) => id === defaultOrganizationId)
  ) {
    return defaultOrganizationId;
  }
  return organizations[0]?.id;
}

export function canManageOrganization(role: string | null | undefined) {
  return hasRole(role, "owner", "admin");
}

export function canDeleteOrganization(role: string | null | undefined) {
  return hasRole(role, "owner");
}

export function assignableOrganizationRoles(
  role: string | null | undefined,
): OrganizationInvitationRole[] {
  if (hasRole(role, "owner")) {
    return [...organizationInvitationRoles];
  }
  if (hasRole(role, "admin")) return ["member", "admin"];
  return [];
}

export function editableOrganizationRoles(
  managerRole: string | null | undefined,
  memberRole: string,
  memberRoles: string[],
): OrganizationInvitationRole[] {
  const assignableRoles = assignableOrganizationRoles(managerRole);
  if (hasRole(memberRole, "owner") && !assignableRoles.includes("owner")) {
    return [];
  }
  const ownerCount = memberRoles.filter((role) =>
    hasRole(role, "owner"),
  ).length;
  if (hasRole(memberRole, "owner") && ownerCount <= 1) {
    return ["owner"];
  }
  return assignableRoles;
}

export function organizationRoleValue(
  role: string,
): OrganizationInvitationRole {
  if (hasRole(role, "owner")) return "owner";
  if (hasRole(role, "admin")) return "admin";
  return "member";
}

export function canLeaveOrganizationWithOwnerCount(
  role: string | null | undefined,
  ownerCount: number,
  hasAnotherOrganization: boolean,
) {
  if (!hasAnotherOrganization) return false;
  if (!hasRole(role, "owner")) return true;
  return ownerCount > 1;
}

/** The roles in a comma-separated role string such as "admin,owner". */
function rolesOf(role: string | null | undefined) {
  return (role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasRole(
  role: string | null | undefined,
  ...expectedRoles: string[]
) {
  return rolesOf(role).some((value) => expectedRoles.includes(value));
}

/** "Admin, Owner" for "admin,owner". */
export function formatRoles(role: string | null | undefined) {
  return rolesOf(role)
    .map((value) => value.charAt(0).toUpperCase() + value.slice(1))
    .join(", ");
}
