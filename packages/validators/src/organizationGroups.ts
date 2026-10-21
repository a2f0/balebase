import { z } from "zod";
import { OrganizationMemberSchema } from "./organizationSettings";
import { route } from "./route";

export const OrganizationCapabilitySchema = z.enum(["finance"]);
export type OrganizationCapability = z.infer<
  typeof OrganizationCapabilitySchema
>;

const OrganizationGroupSchema = z.object({
  capabilities: z.array(OrganizationCapabilitySchema),
  createdAt: z.string(),
  id: z.string(),
  memberUserIds: z.array(z.string()),
  name: z.string(),
  updatedAt: z.string().nullable(),
});
export type OrganizationGroup = z.infer<typeof OrganizationGroupSchema>;

const OrganizationGroupInputSchema = z.object({
  capabilities: z.array(OrganizationCapabilitySchema),
  name: z.string(),
  userIds: z.array(z.string()),
});
export type OrganizationGroupInput = z.infer<
  typeof OrganizationGroupInputSchema
>;

const GroupIdSchema = z.object({ id: z.string() });

export const organizationGroupsRoutes = {
  access: route({
    method: "GET",
    path: "/api/organization-groups/access",
    response: z.object({
      /** What the signed-in user's groups grant them here. */
      capabilities: z.array(OrganizationCapabilitySchema),
      memberRole: z.string(),
      ownerCount: z.number(),
    }),
  }),
  list: route({
    method: "GET",
    path: "/api/organization-groups",
    response: z.object({
      groups: z.array(OrganizationGroupSchema),
      members: z.array(OrganizationMemberSchema),
    }),
  }),
  create: route({
    method: "POST",
    path: "/api/organization-groups",
    body: OrganizationGroupInputSchema,
    response: GroupIdSchema,
  }),
  update: route({
    method: "PATCH",
    path: "/api/organization-groups/:id",
    body: OrganizationGroupInputSchema,
    response: GroupIdSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/organization-groups/:id",
    response: "empty",
  }),
};
