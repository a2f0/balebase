import { z } from "zod";
import { requiredText } from "./fields";
import { OrganizationMemberSchema } from "./organizationSettings";
import { route } from "./route";
import { groupLimits, organizationCapabilities } from "./rules";

const OrganizationCapabilitySchema = z.enum(organizationCapabilities);
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

function unique<Value>(values: Value[]) {
  return [...new Set(values)];
}

const OrganizationGroupInputSchema = z.object({
  capabilities: z.array(OrganizationCapabilitySchema).transform(unique),
  name: requiredText(groupLimits.name),
  /** Replaces the group's members; blanks and repeats are dropped. */
  userIds: z
    .array(z.string().trim())
    .max(groupLimits.members)
    .transform((userIds) => unique(userIds.filter(Boolean))),
});
export type OrganizationGroupInput = z.input<
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
