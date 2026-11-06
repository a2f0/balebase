import type { FinanceFilters } from "@balebase/api-client";

/** The page at `base`, or a page beneath it. */
export function isWithin(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * The record ID in a `<prefix>/<id>` path, if the path is one. A malformed
 * escape is kept as typed, so the page reports an unavailable record instead
 * of throwing.
 */
export function recordIdForPath(pathname: string, prefix: string) {
  if (!pathname.startsWith(`${prefix}/`)) return undefined;
  const segment = /^([^/]+)\/?$/.exec(pathname.slice(prefix.length + 1))?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The library root, or one folder within it. */
export function libraryPath(folderId?: string) {
  return folderId ? `/library/${encodeURIComponent(folderId)}` : "/";
}

export function libraryFolderIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/library");
}

/** One library file's history, readable after the file is deleted. */
export function libraryFilePath(fileId: string) {
  return `/library/files/${encodeURIComponent(fileId)}`;
}

export function libraryFileIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/library/files");
}

/** The equipment list, or one item of equipment. */
export function equipmentPath(equipmentId?: string) {
  return equipmentId
    ? `/equipment/${encodeURIComponent(equipmentId)}`
    : "/equipment";
}

export function equipmentIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/equipment");
}

/** The project list, or one project. */
export function projectPath(projectId?: string) {
  return projectId ? `/projects/${encodeURIComponent(projectId)}` : "/projects";
}

export function projectIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/projects");
}

/** An audit this device started for a project, and keeps until it syncs. */
export function projectAuditPath(projectId: string, auditId: string) {
  return `${projectPath(projectId)}/audits/${encodeURIComponent(auditId)}`;
}

/** The project and device audit in a `projectAuditPath`, if it is one. */
export function projectAuditForPath(pathname: string) {
  const match = /^\/projects\/([^/]+)\/audits\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  return { auditId: decode(match[2]), projectId: decode(match[1]) };
}

/** The business list, or one business. */
export function businessPath(businessId?: string) {
  return businessId
    ? `/businesses/${encodeURIComponent(businessId)}`
    : "/businesses";
}

export function businessIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/businesses");
}

/** The contract list, or one contract. */
export function contractPath(contractId?: string) {
  return contractId
    ? `/contracts/${encodeURIComponent(contractId)}`
    : "/contracts";
}

export function contractIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/contracts");
}

/** Reusable contract template families, separate from issued contracts. */
export function contractTemplatePath(id?: string) {
  return id
    ? `/contracts/templates/${encodeURIComponent(id)}`
    : "/contracts/templates";
}

export function contractTemplateIdForPath(pathname: string) {
  return recordIdForPath(pathname, contractTemplatePath());
}

/** My documents, or the background check form for one request there. */
export function myDocumentsPath(screeningId?: string) {
  return screeningId
    ? `/me/screening/${encodeURIComponent(screeningId)}`
    : "/me";
}

export function myScreeningIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/me/screening");
}

/** One request in My documents: what it is, where it stands, what's next. */
export function myRequirementPath(requirementId: string) {
  return `/me/requests/${encodeURIComponent(requirementId)}`;
}

export function myRequirementIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/me/requests");
}

export function auditRunPath(id: string) {
  return `/audits/runs/${encodeURIComponent(id)}`;
}

/** A form's page, opened on its Projects tab when `tab` says so. */
export function auditTemplatePath(id: string, tab?: "projects") {
  const path = `/audits/templates/${encodeURIComponent(id)}`;
  return tab ? `${path}?tab=${tab}` : path;
}

export function issuePath(id: string) {
  return `/issues/${encodeURIComponent(id)}`;
}

export function transactionIssuePath(id: string) {
  return `/issues/new/transactions/${encodeURIComponent(id)}`;
}

export type FinancePage =
  | "categories"
  | "connections"
  | "overview"
  | "reports"
  | "rules";

export const financePages: {
  label: string;
  page: FinancePage;
  path: string;
}[] = [
  { label: "Overview", page: "overview", path: "/finance" },
  { label: "Reports", page: "reports", path: "/finance/reports" },
  { label: "Categories", page: "categories", path: "/finance/categories" },
  { label: "Rules", page: "rules", path: "/finance/rules" },
  { label: "Connections", page: "connections", path: "/finance/connections" },
];

/** Expense category paths and unknown finance subpaths show the overview. */
export function financePageFor(pathname: string): FinancePage {
  return (
    financePages.find(({ path }) => path !== "/finance" && path === pathname)
      ?.page ?? "overview"
  );
}

const expenseCategoryPrefix = "/finance/expenses/category";
/** The API never gives a category this slug. */
const uncategorizedSlug = "uncategorized";

type ExpenseCategoryFilters = Pick<
  FinanceFilters,
  "categorySlug" | "uncategorized"
>;

/** The overview path that bookmarks a category or the uncategorized bucket. */
export function financeOverviewPath({
  categorySlug,
  uncategorized,
}: ExpenseCategoryFilters) {
  if (uncategorized) return `${expenseCategoryPrefix}/${uncategorizedSlug}`;
  if (categorySlug) {
    return `${expenseCategoryPrefix}/${encodeURIComponent(categorySlug)}`;
  }
  return "/finance";
}

/** The category filters an overview path selects; plain /finance selects none. */
export function expenseCategoryFiltersFor(
  pathname: string,
): ExpenseCategoryFilters {
  const slug = recordIdForPath(pathname, expenseCategoryPrefix);
  if (slug === uncategorizedSlug) {
    return { categorySlug: null, uncategorized: true };
  }
  return { categorySlug: slug || null, uncategorized: false };
}

export const financeCategoriesPath = "/finance/categories";
export const financeRulesPath = "/finance/rules";

/** Rules, with a new categorization rule for `payee` filled in. */
export function financeRulePath(payee: string) {
  return `${financeRulesPath}?${new URLSearchParams({ payee })}`;
}

export function financeAccountPath(id: string) {
  return `/finance/accounts/${encodeURIComponent(id)}`;
}

export function financeConnectionPath(id: string) {
  return `/finance/connections/${encodeURIComponent(id)}`;
}

export function financeTransactionPath(id: string) {
  return `/finance/transactions/${encodeURIComponent(id)}`;
}

export const billingPath = "/organization/billing";

/** Groups and the access they grant. */
export const organizationAccessPath = "/organization/access";

/** The group list, or one group's page. */
export function organizationGroupPath(groupId?: string) {
  return groupId
    ? `${organizationAccessPath}/groups/${encodeURIComponent(groupId)}`
    : organizationAccessPath;
}

export function organizationGroupIdForPath(pathname: string) {
  return recordIdForPath(pathname, `${organizationAccessPath}/groups`);
}

/** The People list, or one member's page. */
export function organizationPeoplePath(memberId?: string) {
  return memberId
    ? `/organization/people/${encodeURIComponent(memberId)}`
    : "/organization/people";
}

export function organizationMemberIdForPath(pathname: string) {
  return recordIdForPath(pathname, organizationPeoplePath());
}

/** A manager's page for one requested form or check, under People. */
export function organizationRequirementPath(requirementId: string) {
  return `/organization/requests/${encodeURIComponent(requirementId)}`;
}

export function organizationRequirementIdForPath(pathname: string) {
  return recordIdForPath(pathname, "/organization/requests");
}

type OrganizationSettingsPage =
  | "access"
  | "api-keys"
  | "billing"
  | "general"
  | "people";

export function organizationSettingsPage(
  pathname: string,
): OrganizationSettingsPage {
  if (
    pathname === organizationPeoplePath() ||
    organizationMemberIdForPath(pathname) ||
    organizationRequirementIdForPath(pathname)
  ) {
    return "people";
  }
  if (
    pathname === organizationAccessPath ||
    organizationGroupIdForPath(pathname)
  )
    return "access";
  if (pathname === "/organization/api-keys") return "api-keys";
  if (pathname === billingPath) return "billing";
  return "general";
}

export function isRootAdminPath(pathname: string) {
  return (
    pathname === "/root/jobs" ||
    isWithin(pathname, adminUserPath()) ||
    isWithin(pathname, adminOrganizationPath()) ||
    isWithin(pathname, globalAuditsPath())
  );
}

export function organizationPathRequiresAccess(pathname: string) {
  return (
    !["/account", "/account/security", "/invite"].includes(pathname) &&
    !isRootAdminPath(pathname)
  );
}

/** Root admin's user list, or one person's platform history there. */
export function adminUserPath(userId?: string) {
  return userId ? `/root/users/${encodeURIComponent(userId)}` : "/root/users";
}

export function adminUserIdForPath(pathname: string) {
  return recordIdForPath(pathname, adminUserPath());
}

/** Root admin's organization list, or one organization there. */
export function adminOrganizationPath(organizationId?: string) {
  return organizationId
    ? `/root/organizations/${encodeURIComponent(organizationId)}`
    : "/root/organizations";
}

export function adminOrganizationIdForPath(pathname: string) {
  return recordIdForPath(pathname, adminOrganizationPath());
}

/** Global Audits, or one global form being managed there. */
export function globalAuditsPath(templateId?: string) {
  return templateId
    ? `/root/global-audits/${encodeURIComponent(templateId)}`
    : "/root/global-audits";
}

export function globalAuditTemplateIdForPath(pathname: string) {
  return recordIdForPath(pathname, globalAuditsPath());
}

/**
 * Where an older link now lives. Background check emails sent before My
 * documents linked to a form under the person's People page.
 */
export function movedWorkspacePath(pathname: string) {
  const segment = /^\/organization\/people\/[^/]+\/screening\/([^/]+)\/?$/.exec(
    pathname,
  )?.[1];
  return segment ? `/me/screening/${segment}` : undefined;
}

/** The token in a public `/sign/<token>` signing link, if the path is one. */
export function signingTokenForPath(pathname: string) {
  return /^\/sign\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname)?.[1];
}

/** Opens one message in the inbox. */
export function inboxEmailPath(
  emailId: string,
  folder: "inbox" | "archived" = "inbox",
) {
  const query = new URLSearchParams({ email: emailId });
  if (folder === "archived") query.set("folder", folder);
  return `/inbox?${query}`;
}
