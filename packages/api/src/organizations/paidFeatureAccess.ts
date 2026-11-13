import { type PaidFeature, paidFeatures } from "@balebase/validators/rules";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "../auth/apiEnv";

export async function paidFeaturesEnabled(
  database: D1Database,
  organizationId: string,
) {
  const row = await database
    .prepare("SELECT paid_features_enabled FROM organization WHERE id = ?")
    .bind(organizationId)
    .first<{ paid_features_enabled: number }>();
  return row?.paid_features_enabled === 1;
}

export function requirePaidFeature(feature: PaidFeature) {
  return createMiddleware<ApiEnv>(async (context, next) => {
    if (
      !(await paidFeaturesEnabled(
        context.env.DB,
        context.get("organizationId"),
      ))
    ) {
      return context.json(
        {
          error: `${paidFeatures[feature]} is disabled for this organization.`,
        },
        403,
      );
    }
    return next();
  });
}
