import { z } from "zod";
import {
  EmployeeRequirementKindSchema,
  EmployeeRequirementStatusSchema,
} from "./employeeForms";
import { OrganizationMemberSchema } from "./organizationSettings";
import { route } from "./route";

// D1 returns these dates as they were stored: ISO text or epoch numbers.
const StoredDateSchema = z.union([z.number(), z.string()]);

const AdminOrganizationSchema = z.object({
  createdAt: StoredDateSchema,
  deletedAt: StoredDateSchema.nullable(),
  deletedByEmail: z.string().nullable(),
  deletedByName: z.string().nullable(),
  deletedByUserId: z.string().nullable(),
  id: z.string(),
  memberCount: z.number(),
  name: z.string(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  /** Plaid connections that are not disconnected. */
  plaidItemCount: z.number(),
  slug: z.string(),
});
export type AdminOrganization = z.infer<typeof AdminOrganizationSchema>;

const AdminOrganizationRequirementSchema = z.object({
  checkrReportUrl: z.string().nullable(),
  checkrResult: z.string().nullable(),
  /** Checkr's report status, or requested while the person hasn't submitted. */
  checkrStatus: z.string().nullable(),
  completedAt: z.string().nullable(),
  dueDate: z.string(),
  id: z.string(),
  kind: EmployeeRequirementKindSchema,
  status: EmployeeRequirementStatusSchema,
  targetEmail: z.string(),
  targetName: z.string().nullable(),
  title: z.string(),
});
export type AdminOrganizationRequirement = z.infer<
  typeof AdminOrganizationRequirementSchema
>;

const AdminOrganizationDetailSchema = z.object({
  members: z.array(OrganizationMemberSchema),
  organization: AdminOrganizationSchema,
  requirements: z.array(AdminOrganizationRequirementSchema),
});
export type AdminOrganizationDetail = z.infer<
  typeof AdminOrganizationDetailSchema
>;

export const adminOrganizationsRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/organizations",
    response: z.object({ organizations: z.array(AdminOrganizationSchema) }),
  }),
  get: route({
    method: "GET",
    path: "/api/admin/organizations/:organizationId",
    response: AdminOrganizationDetailSchema,
  }),
  markForDeletion: route({
    method: "DELETE",
    path: "/api/admin/organizations/:organizationId",
    response: z.object({
      deletedAt: z.string(),
      deletedByEmail: z.string(),
      deletedByName: z.string(),
      deletedByUserId: z.string(),
      organizationId: z.string(),
    }),
  }),
  restore: route({
    method: "POST",
    path: "/api/admin/organizations/:organizationId/restore",
    response: z.object({ organizationId: z.string() }),
  }),
};
