import type { Context } from "hono";
import type { ApiEnv, ApiKeyPrincipal } from "../auth/apiEnv";
import {
  cancelOrganizationSubscription,
  recoverCheckoutAfterFailedDeletion,
} from "../billing/billingDeletion";
import { activityBatch } from "../shared/activity";

interface OrganizationDeletion {
  deletedAt: string;
  organizationId: string;
}

interface OrganizationRestoration {
  organizationId: string;
}

/** Who changed an organization's lifecycle, and with which authority. */
export interface OrganizationLifecycleActor {
  apiKey?: ApiKeyPrincipal | undefined;
  userId: string;
  /** An owner deleting their own organization, or a root admin. */
  via: "owner" | "root_admin";
}

/**
 * Records a lifecycle event against the organization's stored state, while
 * `condition` holds. Deletion and restoration are visible to the
 * organization's managers once it is restored, and to root admins.
 */
function lifecycleEvent(
  database: D1Database,
  action: "organization.deletion_requested" | "organization.restored",
  actor: OrganizationLifecycleActor,
  occurredAt: string,
  details: { bindings: (string | null)[]; sql: string },
  condition: { bindings: (string | null)[]; sql: string },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT organization.id, 'organization', organization.id,
              organization.name, 'organization', organization.id, ?,
              actor.id, actor.name, actor.email, ?, ${details.sql}
       FROM organization JOIN user AS actor ON actor.id = ?
       WHERE ${condition.sql}`,
    )
    .bind(
      action,
      occurredAt,
      ...details.bindings,
      actor.userId,
      ...condition.bindings,
    );
}

async function markOrganizationForDeletion(
  database: D1Database,
  organizationId: string,
  actor: OrganizationLifecycleActor,
  checkoutGuard: string | null,
): Promise<OrganizationDeletion | undefined> {
  const deletedAt = new Date().toISOString();
  const deletedByUserId = actor.userId;
  const results = await activityBatch(database, actor.apiKey, [
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
    // Before invitations are canceled, so it can count them.
    lifecycleEvent(
      database,
      "organization.deletion_requested",
      actor,
      deletedAt,
      {
        bindings: [actor.via],
        sql: `json_object(
          'via', ?,
          'canceledInvitations', (
            SELECT COUNT(*) FROM invitation
            WHERE invitation.organizationId = organization.id
              AND invitation.status = 'pending'
          ))`,
      },
      {
        bindings: [organizationId, deletedAt, deletedByUserId],
        sql: `organization.id = ? AND organization.deletedAt = ?
          AND organization.deletedByUserId = ?`,
      },
    ),
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
  actor: OrganizationLifecycleActor,
): Promise<OrganizationRestoration | undefined> {
  const billing = await database
    .prepare(
      `SELECT checkout_disabled_at FROM organization_billing
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first<{ checkout_disabled_at: string | null }>();
  const restorable = {
    bindings: [organizationId, billing?.checkout_disabled_at ?? null],
    sql: `organization.id = ? AND organization.deletedAt IS NOT NULL
      AND (
        SELECT checkout_disabled_at FROM organization_billing
        WHERE organization_id = organization.id
      ) IS ?`,
  };
  // The event keeps who deleted the organization, which the restore clears.
  const [, result] = await activityBatch(database, actor.apiKey, [
    lifecycleEvent(
      database,
      "organization.restored",
      actor,
      new Date().toISOString(),
      {
        bindings: [actor.via],
        sql: `json_object(
          'via', ?,
          'deletedAt', organization.deletedAt,
          'deletedById', organization.deletedByUserId,
          'deletedByName', (
            SELECT name FROM user WHERE id = organization.deletedByUserId
          ),
          'deletedByEmail', (
            SELECT email FROM user WHERE id = organization.deletedByUserId
          ))`,
      },
      restorable,
    ),
    database
      .prepare(
        `UPDATE organization
         SET deletedAt = NULL, deletedByUserId = NULL
         WHERE ${restorable.sql}`,
      )
      .bind(...restorable.bindings),
  ]);
  if (!result?.meta.changes) return undefined;
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
  actor: OrganizationLifecycleActor,
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
      actor,
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
