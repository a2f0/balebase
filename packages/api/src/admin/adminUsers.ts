import {
  type AdminUser,
  adminUsersRoutes,
} from "@balebase/validators/adminUsers";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { readBody, readQuery, respond } from "../shared/respond";
import {
  cancelUserDeletion,
  requestUserDeletion,
} from "../users/userDeletionActivity";

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
  const query = readQuery(
    context,
    adminUsersRoutes.list,
    "Invalid user pagination.",
  );
  if (query instanceof Response) return query;
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
    ).bind(query.limit, query.offset),
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
  const confirmation =
    "Confirm the user's email to mark this account for deletion.";
  const input = await readBody(
    context,
    adminUsersRoutes.markForDeletion,
    confirmation,
  );
  if (input instanceof Response) return input;
  if (input.confirm !== user.email) {
    return context.json({ error: confirmation }, 400);
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

adminUsers.delete("/:userId/admin", async (context) => {
  const userId = context.req.param("userId");
  if (userId === context.get("authSession").user.id) {
    return context.json(
      { error: "You cannot revoke your own root admin access." },
      403,
    );
  }
  const user = await context.env.DB.prepare(
    "SELECT role FROM user WHERE id = ?",
  )
    .bind(userId)
    .first<{ role: string | null }>();
  if (!user) return context.json({ error: "User not found." }, 404);
  const roles = (user.role ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  if (!roles.includes("admin")) {
    return context.json({ error: "User is not a root admin." }, 409);
  }
  const remaining = roles.filter((role) => role !== "admin").join(",");
  const actor = context.get("authSession").user;
  const newRole = remaining || "user";
  // Both statements apply the same guard on the stored roles of the target and
  // the actor, so a concurrent change, including the actor losing admin (two
  // admins revoking each other), makes them no-ops. The event is inserted first so the update cannot be recorded
  // without its history; the batch is one transaction.
  const guard = `FROM user WHERE id = ? AND role IS ?
    AND EXISTS (SELECT 1 FROM user WHERE id = ?
      AND instr(',' || replace(COALESCE(role, ''), ' ', '') || ',', ',admin,') > 0)`;
  const [, result] = await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO user_role_events
       (id, user_id, action, occurred_at, previous_role, new_role,
        actor_user_id, actor_name, actor_email)
       SELECT ?, id, 'admin_revoked', ?, role, ?, ?, ?, ? ${guard}`,
    ).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      newRole,
      actor.id,
      actor.name,
      actor.email,
      userId,
      user.role,
      actor.id,
    ),
    context.env.DB.prepare(
      `UPDATE user SET role = ?
       WHERE id = ? AND role IS ?
         AND EXISTS (SELECT 1 FROM user WHERE id = ?
           AND instr(',' || replace(COALESCE(role, ''), ' ', '') || ',', ',admin,') > 0)`,
    ).bind(newRole, userId, user.role, actor.id),
  ]);
  if (!result?.meta.changes) {
    return context.json({ error: "User is not a root admin." }, 409);
  }
  return respond(context, adminUsersRoutes.revokeAdmin, { ok: true });
});
