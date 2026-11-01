import {
  accountSettingsRoutes,
  type SecurityEventAction,
  securityEventLimit,
} from "@balebase/validators/accountSettings";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { readBody, respond } from "../shared/respond";

const accountSettings = new Hono<ApiEnv>();

accountSettings.patch("/default-organization", async (context) => {
  const body = await readBody(
    context,
    accountSettingsRoutes.updateDefaultOrganization,
    "An organization is required.",
  );
  if (body instanceof Response) return body;

  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `UPDATE "user" SET "defaultOrganizationId" = ?, "defaultOrganizationPinned" = 1
     WHERE "id" = ?
       AND EXISTS (
         SELECT 1 FROM "member"
         JOIN "organization" ON organization.id = member.organizationId
         WHERE member.userId = "user"."id"
           AND member.organizationId = ?
           AND organization.deletedAt IS NULL
       )`,
  )
    .bind(body.organizationId, userId, body.organizationId)
    .run();
  if (!result.meta.changes) {
    return context.json({ error: "Organization is unavailable." }, 403);
  }
  return respond(context, accountSettingsRoutes.updateDefaultOrganization, {
    defaultOrganizationId: body.organizationId,
  });
});

// Triggers record these when Better Auth changes the person's two-factor
// setting, authenticator, backup codes, password, name or picture (migrations
// 0082 and 0085). Only the person reads them here; root admins read them in D1.
accountSettings.get("/security-events", async (context) => {
  const { results } = await context.env.DB.prepare(
    `SELECT action, occurred_at,
            json_extract(details, '$.before') AS before_value,
            json_extract(details, '$.after') AS after_value
     FROM user_security_events
     WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(context.get("authSession").user.id, securityEventLimit)
    .all<{
      action: SecurityEventAction;
      after_value: string | null;
      before_value: string | null;
      occurred_at: string;
    }>();
  return respond(context, accountSettingsRoutes.securityEvents, {
    events: results.map((row) => ({
      action: row.action,
      change:
        row.action === "name_changed"
          ? { after: row.after_value ?? "", before: row.before_value ?? "" }
          : null,
      occurredAt: row.occurred_at,
    })),
  });
});

export { accountSettings };
