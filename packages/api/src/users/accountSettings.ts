import { accountSettingsRoutes } from "@balebase/validators/accountSettings";
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

export { accountSettings };
