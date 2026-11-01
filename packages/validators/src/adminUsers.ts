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

/**
 * Who made a platform change: a Balebase user, or an operator running
 * `auth:set-role`, who has only the label they gave and no user ID.
 */
const PlatformActorSchema = z.object({
  email: z.string(),
  id: z.string().nullable(),
  kind: z.enum(["user", "operator"]),
  name: z.string(),
});

/** One platform role change or account deletion request or cancellation. */
const AdminUserHistoryEventSchema = z.object({
  action: z.enum([
    "admin_revoked",
    "role_set",
    "deletion_requested",
    "deletion_canceled",
  ]),
  actor: PlatformActorSchema,
  id: z.string(),
  /** Role changes only. */
  newRole: z.string().nullable(),
  occurredAt: z.string(),
  previousRole: z.string().nullable(),
  /** Deletion events only: when the request they made or canceled was made. */
  requestedAt: z.string().nullable(),
});
export type AdminUserHistoryEvent = z.infer<typeof AdminUserHistoryEventSchema>;

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
  history: route({
    method: "GET",
    path: "/api/admin/users/:userId/history",
    query: z.object({ cursor: z.string().max(500).optional() }),
    response: z.object({
      events: z.array(AdminUserHistoryEventSchema),
      nextCursor: z.string().nullable(),
      user: z.object({ email: z.string(), id: z.string(), name: z.string() }),
    }),
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
