import { z } from "zod";
import { PersonSchema } from "./fields";
import { route } from "./route";

/** One person's membership in an organization. */
export const OrganizationMemberSchema = z.object({
  id: z.string(),
  joinedAt: z.string(),
  /** Sent to managers only; null before the account's first visit. */
  lastActiveAt: z.string().nullable().optional(),
  role: z.string(),
  /** Sent to managers only. */
  twoFactorEnabled: z.boolean().optional(),
  /** Sent to managers only. */
  twoFactorRequired: z.boolean().optional(),
  user: PersonSchema,
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

const OrganizationInvitationSchema = z.object({
  email: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  role: z.string(),
  status: z.string(),
});
export type OrganizationInvitation = z.infer<
  typeof OrganizationInvitationSchema
>;

const OrganizationPeopleDataSchema = z.object({
  /** The signed-in user's membership, when they belong to the organization. */
  currentMemberId: z.string().nullable(),
  /** Pending invitations, for managers; empty for everyone else. */
  invitations: z.array(OrganizationInvitationSchema),
  memberRole: z.string(),
  members: z.array(OrganizationMemberSchema),
});
export type OrganizationPeopleData = z.infer<
  typeof OrganizationPeopleDataSchema
>;

export const organizationSettingsRoutes = {
  organizations: route({
    method: "GET",
    path: "/api/organization-settings/organizations",
    response: z.object({
      organizations: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  }),
  people: route({
    method: "GET",
    path: "/api/organization-settings/people",
    response: OrganizationPeopleDataSchema,
  }),
  updateMemberTwoFactorRequirement: route({
    method: "PATCH",
    path: "/api/organization-settings/people/:memberId/two-factor-required",
    body: z.object({ required: z.boolean() }),
    response: z.object({ memberId: z.string(), required: z.boolean() }),
  }),
  deleteCurrent: route({
    method: "DELETE",
    path: "/api/organization-settings/current",
    response: z.object({ deletedAt: z.string(), organizationId: z.string() }),
  }),
};
