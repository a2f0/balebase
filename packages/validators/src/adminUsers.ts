import { z } from "zod";
import { route } from "./route";

const StoredDateSchema = z.union([z.number(), z.string()]);
const AdminUserSchema = z.object({
  banned: z.boolean(),
  createdAt: StoredDateSchema,
  email: z.string(),
  emailVerified: z.boolean(),
  id: z.string(),
  lastActiveAt: StoredDateSchema.nullable(),
  name: z.string(),
  role: z.string(),
  deletionRequestedAt: z.string().nullable(),
  deletionRequestedByName: z.string().nullable(),
  deletionRequestedByEmail: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const adminUsersRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/users",
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .default(0),
    }),
    response: z.object({ total: z.number(), users: z.array(AdminUserSchema) }),
  }),
  markForDeletion: route({
    method: "POST",
    path: "/api/admin/users/:userId/deletion",
    body: z.object({ confirm: z.string() }),
    response: z.object({ requestedAt: z.string() }),
  }),
  cancelDeletion: route({
    method: "DELETE",
    path: "/api/admin/users/:userId/deletion",
    response: z.object({ ok: z.literal(true) }),
  }),
  revokeAdmin: route({
    method: "DELETE",
    path: "/api/admin/users/:userId/admin",
    response: z.object({ ok: z.literal(true) }),
  }),
};
