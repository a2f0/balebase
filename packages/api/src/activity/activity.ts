import { activityRoutes } from "@balebase/validators/activity";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { userHasCapability } from "../organizations/organizationGroups";
import { canManage } from "../organizations/organizationMembers";
import { findActivity } from "../shared/activity";
import { readQuery, respond } from "../shared/respond";

/**
 * The organization activity feed. Finance events need the finance capability,
 * background check events the background checks capability; group and
 * two-factor requirement events need an organization manager.
 */
export const activity = new Hono<ApiEnv>();

activity.get("/", async (context) => {
  const query = readQuery(
    context,
    activityRoutes.list,
    "Invalid activity filters.",
  );
  if (query instanceof Response) return query;
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  const [finance, backgroundChecks] = await Promise.all([
    userHasCapability(context.env.DB, organizationId, userId, "finance"),
    userHasCapability(
      context.env.DB,
      organizationId,
      userId,
      "background_checks",
    ),
  ]);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    query.cursor,
    undefined,
    finance,
    query.resourceType,
    canManage(context),
    backgroundChecks,
  );
  return page
    ? respond(context, activityRoutes.list, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});
