import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "../auth/authMiddleware";

interface OrganizationMemberRow {
  created_at: string;
  email: string;
  id: string;
  last_active_at: string | null;
  name: string;
  role: string;
  two_factor_enabled: number | boolean;
  two_factor_required: number | boolean;
  user_id: string;
}

/** Every member, with the activity and two-factor fields managers see. */
export async function listOrganizationMembers(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT member.id, member.role, member.createdAt AS created_at,
              member.twoFactorRequired AS two_factor_required,
              user.id AS user_id, user.name, user.email,
              user.lastActiveAt AS last_active_at,
              user.twoFactorEnabled AS two_factor_enabled
       FROM member
       JOIN user ON user.id = member.userId
       WHERE member.organizationId = ?
       ORDER BY user.name ASC`,
    )
    .bind(organizationId)
    .all<OrganizationMemberRow>();
  return result.results.map(
    ({
      created_at: joinedAt,
      email,
      id,
      last_active_at: lastActiveAt,
      name,
      role,
      two_factor_enabled: twoFactorEnabled,
      two_factor_required: twoFactorRequired,
      user_id: userId,
    }): Required<OrganizationMember> => ({
      id,
      joinedAt,
      lastActiveAt,
      role,
      twoFactorEnabled: Boolean(twoFactorEnabled),
      twoFactorRequired: Boolean(twoFactorRequired),
      user: { email, id: userId, name },
    }),
  );
}

/** Members' names and addresses, for choosing a person to assign. */
export async function listMemberDirectory(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT user.id, user.name, user.email
       FROM member JOIN user ON user.id = member.userId
       WHERE member.organizationId = ?
       ORDER BY user.name COLLATE NOCASE ASC`,
    )
    .bind(organizationId)
    .all<{ email: string; id: string; name: string }>();
  return result.results;
}

export async function countOrganizationOwners(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM member
       WHERE organizationId = ?
         AND (',' || replace(role, ' ', '') || ',') LIKE '%,owner,%'`,
    )
    .bind(organizationId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export function canManageOrganization(role: string) {
  return role
    .split(",")
    .some((value) => ["owner", "admin"].includes(value.trim()));
}

/** Whether the member making the request is an organization owner or admin. */
export function canManage(context: Context<ApiEnv>) {
  return canManageOrganization(context.get("organizationRole"));
}

export function requireManager(
  error = "Organization manager access required.",
) {
  return createMiddleware<ApiEnv>(async (context, next) => {
    if (!canManage(context)) return context.json({ error }, 403);
    return next();
  });
}

export function isOrganizationOwner(role: string) {
  return role.split(",").some((value) => value.trim() === "owner");
}
