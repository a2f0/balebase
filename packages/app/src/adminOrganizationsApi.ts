import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";
import type {
  EmployeeRequirementKind,
  EmployeeRequirementStatus,
} from "./employeeFormsApi";
import type { OrganizationMember } from "./organizationSettingsApi";

export interface AdminOrganization {
  createdAt: number | string;
  deletedByEmail: string | null;
  deletedByName: string | null;
  deletedByUserId: string | null;
  deletedAt: number | string | null;
  id: string;
  memberCount: number;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  plaidItemCount: number;
  slug: string;
}

export interface AdminOrganizationRequirement {
  /** Checkr's report status, or requested while the person hasn't submitted. */
  checkrStatus: string | null;
  checkrReportUrl: string | null;
  checkrResult: string | null;
  completedAt: string | null;
  dueDate: string;
  id: string;
  kind: EmployeeRequirementKind;
  status: EmployeeRequirementStatus;
  targetEmail: string;
  targetName: string | null;
  title: string;
}

export interface AdminOrganizationDetail {
  members: OrganizationMember[];
  organization: AdminOrganization;
  requirements: AdminOrganizationRequirement[];
}

export async function getAdminOrganization(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}`,
    { credentials: "include" },
  );
  return parseResponse<AdminOrganizationDetail>(response);
}

export async function listAdminOrganizations() {
  const response = await fetchApi(`${apiUrl}/api/admin/organizations`, {
    credentials: "include",
  });
  const body = await parseResponse<{ organizations: AdminOrganization[] }>(
    response,
  );
  return body.organizations;
}

export async function markAdminOrganizationForDeletion(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}`,
    {
      credentials: "include",
      method: "DELETE",
    },
  );
  return parseResponse<{
    deletedAt: string;
    deletedByEmail: string;
    deletedByName: string;
    deletedByUserId: string;
    organizationId: string;
  }>(response);
}

export async function restoreAdminOrganization(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}/restore`,
    {
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{ organizationId: string }>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }

  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
