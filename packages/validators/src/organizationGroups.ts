import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { requiredText } from "./fields";
import { OrganizationMemberSchema } from "./organizationSettings";
import { route } from "./route";
import { groupLimits, organizationCapabilities } from "./rules";

const OrganizationCapabilitySchema = z.enum(organizationCapabilities);
export type OrganizationCapability = z.infer<
  typeof OrganizationCapabilitySchema
>;

/** The id of the Admins group, which follows member roles and has no row. */
export const adminsGroupId = "admins";

const OrganizationGroupSchema = z.object({
  /**
   * Groups the product keeps: `admins` lists owners and admins and cannot be
   * changed here; `finance` and `hr` are the organization's starting Finance
   * and HR groups, which can be edited but not deleted.
   */
  builtIn: z.enum(["admins", "finance", "hr"]).nullable(),
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

const OrganizationGroupUpdateSchema = OrganizationGroupInputSchema.extend({
  /**
   * The capabilities this save decides; the group keeps its others. When it
   * is left out, an API key's save decides every capability, and a signed-in
   * app's decides Finance alone, as apps built before Background checks
   * offered nothing else.
   */
  managedCapabilities: z
    .array(OrganizationCapabilitySchema)
    .transform(unique)
    .optional(),
});
export type OrganizationGroupUpdate = z.input<
  typeof OrganizationGroupUpdateSchema
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
      paidFeaturesEnabled: z.boolean(),
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
    body: OrganizationGroupUpdateSchema,
    response: GroupIdSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/organization-groups/:id",
    response: "empty",
  }),
  /**
   * One group's history, newest first; the Admins group's is its members'
   * role changes.
   */
  activity: route({
    method: "GET",
    path: "/api/organization-groups/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
};
