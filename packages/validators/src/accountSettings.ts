import { z } from "zod";
import { route } from "./route";

const OkSchema = z.object({ ok: z.literal(true) });

export const accountSettingsRoutes = {
  updateDefaultOrganization: route({
    method: "PATCH",
    path: "/api/account-settings/default-organization",
    body: z.object({ organizationId: z.string() }),
    response: z.object({ defaultOrganizationId: z.string() }),
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
