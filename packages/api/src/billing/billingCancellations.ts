import type { ActivityActor } from "../shared/activity";
import { StripeApiError } from "./stripe";
import type { StripeSubscription } from "./stripePayload";

/**
 * A person's cancellation of a paid subscription. Only organization deletion
 * cancels on a person's behalf; replacements during Checkout are
 * Stripe-driven and record nothing until the activity model has a system
 * actor.
 */
export interface SubscriptionCancellation {
  actor: ActivityActor;
  reason: "organization_deletion";
  /** An owner deleting their own organization, or a root admin. */
  via: "owner" | "root_admin";
}

/**
 * How long, in seconds, after its intent a cancellation Stripe reports is
 * still credited to the intent's person. The request cancels within seconds;
 * the window covers a webhook that persists that cancellation instead, and
 * keeps a later, unrelated cancellation from being credited to them.
 */
const intentWindowSeconds = 15 * 60;

/**
 * Stores who is about to cancel a subscription before Stripe is asked to.
 * Whichever write persists the cancellation (this request, or a webhook when
 * this request's write fails) records the event from it, so the person is
 * never lost once Stripe has canceled. A recent unresolved intent is kept, as
 * its request may have canceled already; only a stale one is replaced.
 * Returns whether this request's intent is the stored one.
 */
export async function recordCancellationIntent(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  cancellation: SubscriptionCancellation,
) {
  const stored = await database
    .prepare(
      `INSERT INTO billing_cancellation_intents (
         subscription_id, organization_id, actor_user_id, api_key_id,
         api_key_channel, via, reason, previous_status, created_at
       )
       SELECT ?, organization.id, ?, ?, ?, ?, ?, (
                SELECT stripe_status FROM organization_billing
                WHERE organization_id = organization.id
                  AND stripe_subscription_id = ?
              ), ?
       FROM organization WHERE organization.id = ?
       ON CONFLICT (subscription_id) DO UPDATE SET
         organization_id = excluded.organization_id,
         actor_user_id = excluded.actor_user_id,
         api_key_id = excluded.api_key_id,
         api_key_channel = excluded.api_key_channel,
         via = excluded.via,
         reason = excluded.reason,
         previous_status = excluded.previous_status,
         created_at = excluded.created_at
       WHERE billing_cancellation_intents.created_at
             < excluded.created_at - ${intentWindowSeconds}`,
    )
    .bind(
      subscriptionId,
      cancellation.actor.userId,
      cancellation.actor.apiKey?.id ?? null,
      cancellation.actor.apiKey?.channel ?? null,
      cancellation.via,
      cancellation.reason,
      subscriptionId,
      Math.floor(Date.now() / 1_000),
      organizationId,
    )
    .run();
  return Number(stored.meta.changes) > 0;
}

/**
 * Drops this request's intent when Stripe definitively refused the
 * cancellation. After an indeterminate failure (a 5xx or a dropped
 * connection) Stripe may still have canceled, so the intent stays for the
 * webhook, as does an earlier request's intent this one did not replace.
 */
export async function forgetRefusedCancellation(
  database: D1Database,
  subscriptionId: string,
  cause: unknown,
) {
  if (
    !(cause instanceof StripeApiError) ||
    cause.status < 400 ||
    cause.status >= 500
  ) {
    return;
  }
  await database
    .prepare(
      "DELETE FROM billing_cancellation_intents WHERE subscription_id = ?",
    )
    .bind(subscriptionId)
    .run();
}

/**
 * Statements that go first in the batch persisting a canceled subscription:
 * the event credited to a recent intent's person, once per subscription,
 * then the intent's removal. The event reads the status stored when the
 * intent was made, and does not depend on the persisting write, which skips
 * a subscription the organization does not track (a completed pending
 * Checkout): Stripe has canceled it either way.
 */
export function canceledSubscriptionStatements(
  database: D1Database,
  subscription: StripeSubscription,
  seatQuantity: number,
) {
  const canceledAt = subscription.canceled_at ?? Math.floor(Date.now() / 1_000);
  return [
    database
      .prepare(
        `INSERT INTO activity_events (
           organization_id, root_type, root_id, root_label, subject_type,
           subject_id, action, actor_user_id, actor_name, actor_email,
           actor_api_key_id, actor_api_key_name, actor_api_key_channel,
           occurred_at, details
         )
         SELECT organization.id, 'organization_billing', organization.id,
                organization.name, 'billing_subscription',
                intent.subscription_id, 'billing.subscription_canceled',
                actor.id, actor.name, actor.email, api_key.id, api_key.name,
                CASE WHEN api_key.id IS NULL THEN NULL
                     ELSE intent.api_key_channel END,
                ?,
                json_object(
                  'reason', intent.reason, 'via', intent.via,
                  'subscriptionId', intent.subscription_id,
                  'previousStatus', intent.previous_status,
                  'seatQuantity', ?)
         FROM billing_cancellation_intents AS intent
         JOIN organization ON organization.id = intent.organization_id
         JOIN user AS actor ON actor.id = intent.actor_user_id
         LEFT JOIN organization_api_keys AS api_key
           ON api_key.id = intent.api_key_id
          AND api_key.created_by = intent.actor_user_id
          AND api_key.organization_id = intent.organization_id
         WHERE intent.subscription_id = ?
           AND ? BETWEEN intent.created_at - 60
                     AND intent.created_at + ${intentWindowSeconds}
           AND NOT EXISTS (
             SELECT 1 FROM activity_events
             WHERE organization_id = intent.organization_id
               AND action = 'billing.subscription_canceled'
               AND subject_id = intent.subscription_id
           )`,
      )
      .bind(
        new Date(canceledAt * 1_000).toISOString(),
        seatQuantity,
        subscription.id,
        canceledAt,
      ),
    database
      .prepare(
        "DELETE FROM billing_cancellation_intents WHERE subscription_id = ?",
      )
      .bind(subscription.id),
  ];
}
