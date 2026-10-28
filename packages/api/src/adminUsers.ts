import {
  type AdminUser,
  adminUsersRoutes,
} from "@balebase/validators/adminUsers";
import { Hono } from "hono";
import type { ApiEnv } from "./authMiddleware";
import { respond } from "./respond";
import {
  cancelUserDeletion,
  requestUserDeletion,
} from "./userDeletionActivity";

interface AdminUserRow extends Omit<AdminUser, "banned" | "emailVerified"> {
  banned: number;
  emailVerified: number;
}

export const adminUsers = new Hono<ApiEnv>();
adminUsers.use("*", async (context, next) => {
  if (context.get("authSession").session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot manage user deletion." },
      403,
    );
  }
  if (
    context.req.method !== "GET" &&
    context.req.header("Origin") !== context.env.CORS_ORIGIN
  ) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  return next();
});

adminUsers.get("/", async (context) => {
  const query = adminUsersRoutes.list.query.safeParse(context.req.query());
  if (!query.success)
    return context.json({ error: "Invalid user pagination." }, 400);
  const [users, count] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT user.id, user.name, user.email, user.emailVerified, user.createdAt,
              user.lastActiveAt, COALESCE(user.role, 'user') AS role,
              COALESCE(user.banned, 0) AS banned,
              request.requested_at AS deletionRequestedAt,
              request.requested_by_name AS deletionRequestedByName,
              request.requested_by_email AS deletionRequestedByEmail
       FROM user LEFT JOIN user_deletion_requests AS request ON request.user_id = user.id
       WHERE user.id NOT LIKE 'system:%'
       ORDER BY user.createdAt DESC, user.id LIMIT ? OFFSET ?`,
    ).bind(query.data.limit, query.data.offset),
    context.env.DB.prepare(
      "SELECT COUNT(*) AS total FROM user WHERE id NOT LIKE 'system:%'",
    ),
  ]);
  if (!users || !count) throw new Error("Could not load users.");
  return respond(context, adminUsersRoutes.list, {
    total: (count.results[0] as { total: number }).total,
    users: (users.results as AdminUserRow[]).map((user) => ({
      ...user,
      banned: Boolean(user.banned),
      emailVerified: Boolean(user.emailVerified),
    })),
  });
});

adminUsers.post("/:userId/deletion", async (context) => {
  const userId = context.req.param("userId");
  const actor = context.get("authSession").user;
  const user = await context.env.DB.prepare(
    "SELECT email, role FROM user WHERE id = ?",
  )
    .bind(userId)
    .first<{ email: string; role: string | null }>();
  if (!user) return context.json({ error: "User not found." }, 404);
  if (
    userId === actor.id ||
    userId.startsWith("system:") ||
    user.role?.split(",").some((role) => role.trim() === "admin")
  ) {
    return context.json(
      {
        error:
          "Your own account, admin accounts, and system accounts cannot be marked for deletion here.",
      },
      403,
    );
  }
  const input = adminUsersRoutes.markForDeletion.body.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!input.success || input.data.confirm !== user.email) {
    return context.json(
      { error: "Confirm the user's email to mark this account for deletion." },
      400,
    );
  }
  const requestedAt = await requestUserDeletion(
    context.env.DB,
    userId,
    actor,
    true,
  );
  if (!requestedAt)
    return context.json(
      {
        error: "User is already marked for deletion or is no longer eligible.",
      },
      409,
    );
  return respond(context, adminUsersRoutes.markForDeletion, { requestedAt });
});

adminUsers.delete("/:userId/deletion", async (context) => {
  const userId = context.req.param("userId");
  const user = await context.env.DB.prepare("SELECT id FROM user WHERE id = ?")
    .bind(userId)
    .first();
  if (!user) return context.json({ error: "User not found." }, 404);
  const canceled = await cancelUserDeletion(
    context.env.DB,
    userId,
    context.get("authSession").user,
  );
  if (!canceled)
    return context.json({ error: "User is not marked for deletion." }, 409);
  return respond(context, adminUsersRoutes.cancelDeletion, { ok: true });
});
