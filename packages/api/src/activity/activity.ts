import { activityRoutes } from "@balebase/validators/activity";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { userHasCapability } from "../organizations/organizationGroups";
import { findActivity } from "../shared/activity";
import { readQuery, respond } from "../shared/respond";

/** The organization activity feed; finance events need the finance capability. */
export const activity = new Hono<ApiEnv>();

activity.get("/", async (context) => {
  const query = readQuery(
    context,
    activityRoutes.list,
    "Invalid activity filters.",
  );
  if (query instanceof Response) return query;
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    query.cursor,
    undefined,
    await userHasCapability(
      context.env.DB,
      context.get("organizationId"),
      context.get("authSession").user.id,
      "finance",
    ),
    query.resourceType,
  );
  return page
    ? respond(context, activityRoutes.list, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});
