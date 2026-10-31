import { z } from "zod";
import { route } from "./route";

const OkSchema = z.object({ ok: z.literal(true) });

const securityEventActions = [
  "two_factor_enabled",
  "two_factor_disabled",
  "password_changed",
] as const;
export type SecurityEventAction = (typeof securityEventActions)[number];
/** How many of a person's latest security changes the account page lists. */
export const securityEventLimit = 50;

export const accountSettingsRoutes = {
  updateDefaultOrganization: route({
    method: "PATCH",
    path: "/api/account-settings/default-organization",
    body: z.object({ organizationId: z.string().min(1) }),
    response: z.object({ defaultOrganizationId: z.string() }),
  }),
  securityEvents: route({
    method: "GET",
    path: "/api/account-settings/security-events",
    response: z.object({
      /** The signed-in person's own latest security changes, newest first. */
      events: z.array(
        z.object({
          action: z.enum(securityEventActions),
          occurredAt: z.string(),
        }),
      ),
    }),
  }),
  deletion: route({
    method: "GET",
    path: "/api/account-settings/deletion",
    response: z.object({
      /** When the user asked for their account to be deleted, if they have. */
      requestedAt: z.string().nullable(),
    }),
  }),
  requestDeletion: route({
    method: "POST",
    path: "/api/account-settings/deletion",
    body: z.object({ confirm: z.literal("delete my account") }),
    response: OkSchema,
  }),
  cancelDeletion: route({
    method: "DELETE",
    path: "/api/account-settings/deletion",
    response: OkSchema,
  }),
};
