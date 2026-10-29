import type { Context } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  cancelOrganizationSubscription,
  recoverCheckoutAfterFailedDeletion,
} from "../billing/billingDeletion";

interface OrganizationDeletion {
  deletedAt: string;
  organizationId: string;
}

interface OrganizationRestoration {
  organizationId: string;
}

async function markOrganizationForDeletion(
  database: D1Database,
  organizationId: string,
  deletedByUserId: string,
  checkoutGuard: string | null,
): Promise<OrganizationDeletion | undefined> {
  const deletedAt = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE organization
         SET deletedAt = ?, deletedByUserId = ?
         WHERE id = ? AND deletedAt IS NULL
           AND EXISTS (
             SELECT 1 FROM organization_billing
             WHERE organization_id = organization.id
               AND checkout_disabled_at IS ?
               AND COALESCE(checkout_disabled_expires_at, 0) > unixepoch()
           )`,
      )
      .bind(deletedAt, deletedByUserId, organizationId, checkoutGuard),
    database
      .prepare(
        `UPDATE invitation
         SET status = 'canceled'
         WHERE organizationId = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(organizationId, organizationId, deletedAt, deletedByUserId),
    database
      .prepare(
        `UPDATE user
         SET defaultOrganizationId = (
           SELECT member.organizationId
           FROM member
           JOIN organization
             ON organization.id = member.organizationId
           WHERE member.userId = user.id
             AND member.organizationId != ?
             AND organization.deletedAt IS NULL
           ORDER BY member.createdAt ASC, member.id ASC
           LIMIT 1
         )
         WHERE defaultOrganizationId = ?
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(
        organizationId,
        organizationId,
        organizationId,
        deletedAt,
        deletedByUserId,
      ),
    database
      .prepare(
        `UPDATE session
         SET activeOrganizationId = CASE
               WHEN activeOrganizationId = ? THEN (
                 SELECT defaultOrganizationId
                 FROM user
                 WHERE user.id = session.userId
               )
               ELSE activeOrganizationId
             END,
             activeTeamId = NULL
         WHERE (
           activeOrganizationId = ?
           OR activeTeamId IN (
              SELECT id FROM team WHERE organizationId = ?
            )
         )
           AND EXISTS (
             SELECT 1 FROM organization
             WHERE id = ? AND deletedAt = ? AND deletedByUserId = ?
           )`,
      )
      .bind(
        organizationId,
        organizationId,
        organizationId,
        organizationId,
        deletedAt,
        deletedByUserId,
      ),
  ]);

  if (!results[0]?.meta.changes) return undefined;
  return { deletedAt, organizationId };
}

export async function restoreOrganization(
  database: D1Database,
  organizationId: string,
): Promise<OrganizationRestoration | undefined> {
  const billing = await database
    .prepare(
      `SELECT checkout_disabled_at FROM organization_billing
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first<{ checkout_disabled_at: string | null }>();
  const result = await database
    .prepare(
      `UPDATE organization
       SET deletedAt = NULL, deletedByUserId = NULL
       WHERE id = ? AND deletedAt IS NOT NULL
         AND (
           SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = organization.id
         ) IS ?`,
    )
    .bind(organizationId, billing?.checkout_disabled_at ?? null)
    .run();
  if (result.meta.changes < 1) return undefined;
  return { organizationId };
}

/**
 * Cancels the organization's billing, then marks it for deletion. When the
 * mark fails or changes nothing, checkout is re-enabled so billing can be
 * restarted. A failure carries the response the route sends.
 */
export async function deleteBilledOrganization(
  context: Context<ApiEnv>,
  organizationId: string,
  deletedByUserId: string,
): Promise<
  | { deletion: OrganizationDeletion }
  | { deletion: undefined }
  | { response: Response }
> {
  let checkoutGuard: string | null;
  try {
    ({ checkoutGuard } = await cancelOrganizationSubscription(
      context.env,
      organizationId,
    ));
  } catch (cause) {
    console.error("Could not cancel organization billing.", cause);
    const error =
      "The Stripe subscription could not be canceled, so the organization was not deleted.";
    return { response: context.json({ error }, 502) };
  }

  let deletion: OrganizationDeletion | undefined;
  try {
    deletion = await markOrganizationForDeletion(
      context.env.DB,
      organizationId,
      deletedByUserId,
      checkoutGuard,
    );
  } catch (cause) {
    console.error("Could not record organization deletion.", cause);
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
    const error =
      "Billing was canceled, but the organization could not be deleted. Checkout was re-enabled so billing can be restarted.";
    return { response: context.json({ error }, 500) };
  }
  if (!deletion) {
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
  }
  return { deletion };
}
