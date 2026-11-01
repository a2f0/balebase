import {
  type ActivityCausation,
  providerActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";

/**
 * What made Balebase store a subscription's new state: a Stripe event, or a
 * Checkout session confirmed by the person returning from it or by the
 * pending Checkout reconciliation. Stripe is the actor either way; the
 * person who started Checkout is recorded by `billing.checkout_started`,
 * which `checkoutSessionId` names.
 */
export interface SubscriptionChangeCause {
  causation: ActivityCausation;
  checkoutSessionId?: string | undefined;
  /** Set when Balebase canceled it because a new Checkout replaced it. */
  replacedBySubscriptionId?: string | undefined;
}

/** The subscription fields `billing.subscription_changed` compares. */
export interface StoredSubscription {
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  priceId: string | null;
  seats: number;
  status: string;
  subscriptionId: string;
}

/** A write's condition over `billing`, its `organization_billing` row. */
export interface BillingGuard {
  bindings: (string | number | null)[];
  sql: string;
}

/** The stored subscription as `billing.subscription_changed` shows it. */
const storedSubscription = `json_object(
  'subscriptionId', billing.stripe_subscription_id,
  'status', billing.stripe_status, 'priceId', billing.stripe_price_id,
  'seats', billing.seat_quantity,
  'cancelAtPeriodEnd', json(CASE WHEN billing.cancel_at_period_end
                                 THEN 'true' ELSE 'false' END),
  'periodEnd', billing.current_period_end)`;

/**
 * Records `billing.subscription_changed` by Stripe, with the stored values
 * before and the new ones after, when the write it precedes in the batch
 * will change a tracked field. `guard` must repeat that write's own
 * condition over `billing` (the organization's `organization_billing` row,
 * NULL when there is none), so nothing is recorded when it changes nothing.
 * Put it before the write, so it reads the stored values. A cancellation
 * whose person is recorded (`billing.subscription_canceled`, by a statement
 * earlier in the batch or before) is theirs, so Stripe records nothing.
 */
export function subscriptionChangeStatement(
  database: D1Database,
  cause: SubscriptionChangeCause,
  organizationId: string,
  after: StoredSubscription,
  guard: BillingGuard,
) {
  // JSON drops the undefined ones.
  const extra = {
    checkoutSessionId: cause.checkoutSessionId,
    reason: cause.replacedBySubscriptionId ? "replaced" : undefined,
    replacedBySubscriptionId: cause.replacedBySubscriptionId,
    stripeEventId:
      cause.causation.type === "stripe_event" ? cause.causation.id : undefined,
  };
  const cancelAtPeriodEnd = after.cancelAtPeriodEnd ? 1 : 0;
  return systemActivityRowsStatement(
    database,
    providerActor("stripe", cause.causation),
    new Date().toISOString(),
    {
      bindings: [
        after.subscriptionId,
        after.subscriptionId,
        after.subscriptionId,
        after.status,
        after.priceId,
        after.seats,
        String(after.cancelAtPeriodEnd),
        after.periodEnd,
        JSON.stringify(extra),
        organizationId,
        ...guard.bindings,
        after.subscriptionId,
        after.status,
        after.priceId,
        after.seats,
        cancelAtPeriodEnd,
        after.periodEnd,
        after.status,
        after.subscriptionId,
      ],
      sql: `SELECT organization.id AS organization_id,
                   'organization_billing' AS root_type,
                   organization.id AS root_id, organization.name AS root_label,
                   'stripe_subscription' AS subject_type, ? AS subject_id,
                   'billing.subscription_changed' AS action,
                   json_patch(json_object(
                     'subscriptionId', ?,
                     'before', CASE WHEN billing.stripe_subscription_id IS NULL
                                    THEN NULL ELSE ${storedSubscription} END,
                     'after', json_object(
                       'subscriptionId', ?, 'status', ?, 'priceId', ?,
                       'seats', ?, 'cancelAtPeriodEnd', json(?),
                       'periodEnd', ?)
                   ), ?) AS details
            FROM organization
            LEFT JOIN organization_billing AS billing
              ON billing.organization_id = organization.id
            WHERE organization.id = ? AND (${guard.sql})
              AND (billing.stripe_subscription_id IS NOT ?
                   OR billing.stripe_status IS NOT ?
                   OR billing.stripe_price_id IS NOT ?
                   OR billing.seat_quantity IS NOT ?
                   OR billing.cancel_at_period_end IS NOT ?
                   OR billing.current_period_end IS NOT ?)
              AND NOT (? = 'canceled' AND EXISTS (
                SELECT 1 FROM activity_events AS recorded
                WHERE recorded.organization_id = organization.id
                  AND recorded.action = 'billing.subscription_canceled'
                  AND recorded.subject_id = ?))`,
    },
  );
}

/**
 * Records `billing.seats_changed` by Stripe when the stored seat quantity of
 * the subscription item will change. Put it before the update it describes.
 * `source` says what asked for the quantity: a membership change, whose own
 * event names the person, or the hourly reconciliation.
 */
export function seatChangeStatement(
  database: D1Database,
  causation: ActivityCausation | null,
  organizationId: string,
  subscriptionItemId: string,
  quantity: number,
  source: "membership" | "reconciliation",
) {
  return systemActivityRowsStatement(
    database,
    providerActor("stripe", causation),
    new Date().toISOString(),
    {
      bindings: [
        quantity,
        source,
        organizationId,
        subscriptionItemId,
        quantity,
      ],
      sql: `SELECT organization.id AS organization_id,
                   'organization_billing' AS root_type,
                   organization.id AS root_id, organization.name AS root_label,
                   'stripe_subscription' AS subject_type,
                   COALESCE(billing.stripe_subscription_id,
                            billing.stripe_subscription_item_id) AS subject_id,
                   'billing.seats_changed' AS action,
                   json_object(
                     'subscriptionId', billing.stripe_subscription_id,
                     'before', billing.seat_quantity, 'after', ?,
                     'source', ?) AS details
            FROM organization
            JOIN organization_billing AS billing
              ON billing.organization_id = organization.id
            WHERE organization.id = ?
              AND billing.stripe_subscription_item_id = ?
              AND billing.seat_quantity IS NOT ?`,
    },
  );
}
