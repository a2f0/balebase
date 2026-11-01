import type { ActivityCausation } from "../shared/systemActivity";
import type { Bindings } from "../types";
import {
  attachCheckoutSessionToClaim,
  checkoutDeletionInProgress,
  clearExpiredCheckoutDeletionLease,
  clearPendingCheckoutIfCurrent,
  releaseCheckoutClaim,
} from "./billingCheckout";
import {
  findProSubscriptionItem,
  type ProPriceEnvironment,
  paidStatuses,
  paidStatusList,
} from "./billingEntitlements";
import {
  type BillingGuard,
  type StoredSubscription,
  type SubscriptionChangeCause,
  subscriptionChangeStatement,
} from "./billingProviderActivity";
import {
  clearSettledCheckout,
  findBilling,
  organizationExists,
  settledCheckoutBindings,
} from "./billingRecords";
import { withSubscriptionSyncLock } from "./billingSeats";
import { StripeApiError, stripeDelete, stripeGet } from "./stripe";
import {
  expandableId,
  parseStripeSubscription,
  type StripeExpandable,
  type StripeSubscription,
} from "./stripePayload";

export const terminalSubscriptionStatuses = new Set([
  "canceled",
  "incomplete_expired",
]);

export type SubscriptionEnvironment = ProPriceEnvironment &
  Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">;

/**
 * Stores the subscription's current state from Stripe. `causation` is what
 * reported it (a Stripe event, or a Checkout session), recorded with the
 * `billing.subscription_changed` event a real change makes.
 */
export async function refreshSubscription(
  environment: SubscriptionEnvironment,
  subscriptionId: string,
  eventCreated: number,
  causation: ActivityCausation,
  knownOrganizationId?: string,
  checkoutSessionId?: string,
  checkoutClaimId?: string,
) {
  const checkoutRefresh = Boolean(checkoutSessionId && knownOrganizationId);
  const cause: SubscriptionChangeCause = { causation, checkoutSessionId };
  return withSubscriptionSyncLock(
    environment.DB,
    subscriptionId,
    async () => {
      if (
        checkoutSessionId &&
        knownOrganizationId &&
        (await checkoutSubscriptionAlreadyPersisted(
          environment.DB,
          knownOrganizationId,
          subscriptionId,
          checkoutClaimId,
        ))
      ) {
        return true;
      }
      const subscription = await expandedSubscription(
        environment,
        subscriptionId,
      );
      if (!subscription) return false;
      if (
        checkoutSessionId &&
        knownOrganizationId &&
        !(await prepareCheckoutSubscriptionReplacement(
          environment,
          knownOrganizationId,
          checkoutSessionId,
          checkoutClaimId,
          subscription,
          cause,
        ))
      ) {
        return false;
      }
      const persisted = await persistSubscription(
        environment,
        subscription,
        eventCreated,
        cause,
        knownOrganizationId,
        checkoutSessionId,
      );
      if (persisted || !checkoutSessionId || !knownOrganizationId) {
        return persisted;
      }
      return resolveRejectedCheckoutPersistence(
        environment,
        knownOrganizationId,
        subscription,
      );
    },
    checkoutRefresh,
  );
}

async function checkoutSubscriptionAlreadyPersisted(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  checkoutClaimId: string | undefined,
) {
  const current = await findBilling(database, organizationId);
  const persisted =
    current?.stripe_subscription_id === subscriptionId &&
    !current.pending_checkout_session_id;
  if (persisted && checkoutClaimId) {
    await releaseCheckoutClaim(database, organizationId, checkoutClaimId);
  }
  return persisted;
}

async function prepareCheckoutSubscriptionReplacement(
  environment: SubscriptionEnvironment,
  organizationId: string,
  checkoutSessionId: string,
  checkoutClaimId: string | undefined,
  subscription: StripeSubscription,
  cause: SubscriptionChangeCause,
) {
  await clearExpiredCheckoutDeletionLease(
    environment.DB,
    organizationId,
    Math.floor(Date.now() / 1_000),
  );
  if (checkoutClaimId) {
    await attachCheckoutSessionToClaim(
      environment.DB,
      organizationId,
      checkoutClaimId,
      checkoutSessionId,
    );
  }
  const existing = await findBilling(environment.DB, organizationId);
  const matchesCurrent = existing?.stripe_subscription_id === subscription.id;
  const matchesPending =
    existing?.pending_checkout_session_id === checkoutSessionId;
  const hasExpectedProEntitlement = Boolean(
    paidStatuses.has(subscription.status) &&
      findProSubscriptionItem(subscription, environment),
  );
  if (!hasExpectedProEntitlement) {
    if (!matchesCurrent) {
      await cancelUntrackedSubscription(environment, subscription);
    }
    if (matchesPending) {
      await clearPendingCheckoutIfCurrent(
        environment.DB,
        organizationId,
        checkoutSessionId,
      );
    }
    return false;
  }
  if (
    checkoutDeletionInProgress(existing, Math.floor(Date.now() / 1_000)) ||
    (!matchesPending &&
      (!matchesCurrent || Boolean(existing?.pending_checkout_session_id)))
  ) {
    if (!matchesCurrent) {
      await cancelUntrackedSubscription(environment, subscription);
    }
    return false;
  }
  if (
    existing.stripe_subscription_id &&
    existing.stripe_subscription_id !== subscription.id &&
    !terminalSubscriptionStatuses.has(existing.stripe_status ?? "")
  ) {
    await cancelStripeSubscription(
      environment,
      organizationId,
      existing.stripe_subscription_id,
      { ...cause, replacedBySubscriptionId: subscription.id },
    );
  }
  return true;
}

async function resolveRejectedCheckoutPersistence(
  environment: Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">,
  organizationId: string,
  subscription: StripeSubscription,
) {
  const current = await findBilling(environment.DB, organizationId);
  if (
    current?.stripe_subscription_id === subscription.id &&
    !current.pending_checkout_session_id
  ) {
    return true;
  }
  if (current?.stripe_subscription_id !== subscription.id) {
    await cancelUntrackedSubscription(environment, subscription);
  }
  return false;
}

async function cancelUntrackedSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  subscription: StripeSubscription,
) {
  if (terminalSubscriptionStatuses.has(subscription.status)) return;
  try {
    await deleteStripeSubscription(environment, subscription.id);
  } catch (cause) {
    if (!(cause instanceof StripeApiError) || cause.status !== 404) throw cause;
  }
}

async function expandedSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  value: StripeExpandable | StripeSubscription | null,
) {
  if (!value) return null;
  if (typeof value === "object" && "items" in value) return value;
  const id = expandableId(value);
  return parseStripeSubscription(
    await stripeGet(environment, `/v1/subscriptions/${encodeURIComponent(id)}`),
  );
}

/**
 * Stores the subscription's state and, in the same batch, records what
 * changed as `billing.subscription_changed` by Stripe, unless `cause` is null
 * because a person's own event records the change.
 */
async function persistSubscription(
  environment: ProPriceEnvironment & Pick<Bindings, "DB">,
  subscription: StripeSubscription,
  eventCreated: number,
  cause: SubscriptionChangeCause | null,
  knownOrganizationId?: string,
  checkoutSessionId?: string,
) {
  const customerId = expandableId(subscription.customer);
  const organizationId =
    knownOrganizationId ??
    subscription.metadata?.organization_id ??
    (await organizationForStripeRecord(
      environment.DB,
      subscription.id,
      customerId,
    ));
  if (
    !organizationId ||
    !(await organizationExists(environment.DB, organizationId))
  ) {
    return false;
  }
  const item = findProSubscriptionItem(subscription, environment);
  const stored = storedSubscription(subscription, environment);
  const { cancelAtPeriodEnd } = stored;
  // paid_ended_at marks when a paid status lapsed, so retention can grant a
  // grace period. Stripe reports no end time for unpaid or paused
  // subscriptions, and processing time is never earlier than the real end.
  const now = new Date().toISOString();
  const persist = (write: D1PreparedStatement, guard: BillingGuard) =>
    writeWithChange(
      environment.DB,
      write,
      cause && { cause, guard, organizationId, stored },
    );
  if (checkoutSessionId) {
    const update = environment.DB.prepare(
      `UPDATE organization_billing
       SET stripe_customer_id = ?, stripe_subscription_id = ?,
           stripe_subscription_item_id = ?, stripe_price_id = ?,
           stripe_status = ?, seat_quantity = ?, cancel_at_period_end = ?,
           current_period_end = ?,
           stripe_event_created = MAX(stripe_event_created, ?),
           paid_ended_at = CASE
             WHEN ? IN ${paidStatusList} THEN NULL
             WHEN COALESCE(stripe_status, '') IN ${paidStatusList} THEN ?
             ELSE paid_ended_at
           END,
           ${clearSettledCheckout},
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at IS NULL
         AND (pending_checkout_session_id = ?
              OR (stripe_subscription_id = ?
                  AND pending_checkout_session_id IS NULL))`,
    ).bind(
      customerId,
      subscription.id,
      item?.id ?? null,
      stored.priceId,
      subscription.status,
      stored.seats,
      cancelAtPeriodEnd ? 1 : 0,
      stored.periodEnd,
      eventCreated,
      subscription.status,
      now,
      ...Array<string>(settledCheckoutBindings).fill(checkoutSessionId),
      now,
      organizationId,
      checkoutSessionId,
      subscription.id,
    );
    return persist(update, {
      bindings: [checkoutSessionId, subscription.id],
      sql: `billing.checkout_disabled_at IS NULL
            AND (billing.pending_checkout_session_id = ?
                 OR (billing.stripe_subscription_id = ?
                     AND billing.pending_checkout_session_id IS NULL))`,
    });
  }
  const upsert = environment.DB.prepare(
    `INSERT INTO organization_billing
     (organization_id, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, stripe_price_id, stripe_status,
      seat_quantity, cancel_at_period_end, current_period_end,
      stripe_event_created, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organization_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_subscription_item_id = excluded.stripe_subscription_item_id,
       stripe_price_id = excluded.stripe_price_id,
       stripe_status = excluded.stripe_status,
       seat_quantity = excluded.seat_quantity,
       cancel_at_period_end = excluded.cancel_at_period_end,
       current_period_end = excluded.current_period_end,
       stripe_event_created = MAX(
         organization_billing.stripe_event_created,
         excluded.stripe_event_created
       ),
       paid_ended_at = CASE
         WHEN excluded.stripe_status IN ${paidStatusList}
           THEN NULL
         WHEN COALESCE(organization_billing.stripe_status, '') IN
           ${paidStatusList} THEN excluded.updated_at
         ELSE organization_billing.paid_ended_at
       END,
       updated_at = excluded.updated_at
     WHERE organization_billing.stripe_subscription_id IS NULL
        OR organization_billing.stripe_subscription_id =
           excluded.stripe_subscription_id`,
  ).bind(
    organizationId,
    customerId,
    subscription.id,
    item?.id ?? null,
    stored.priceId,
    subscription.status,
    stored.seats,
    cancelAtPeriodEnd ? 1 : 0,
    stored.periodEnd,
    eventCreated,
    now,
  );
  return persist(upsert, {
    bindings: [subscription.id],
    sql: `billing.stripe_subscription_id IS NULL
          OR billing.stripe_subscription_id = ?`,
  });
}

/** The subscription's fields as `organization_billing` stores them. */
function storedSubscription(
  subscription: StripeSubscription,
  environment: ProPriceEnvironment,
): StoredSubscription {
  const item = findProSubscriptionItem(subscription, environment);
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  return {
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end === true ||
      subscription.cancel_at != null,
    periodEnd: periodEnd ? new Date(periodEnd * 1_000).toISOString() : null,
    priceId: item?.price.id ?? null,
    seats: Math.max(1, item?.quantity ?? 1),
    status: subscription.status,
    subscriptionId: subscription.id,
  };
}

/**
 * Runs `write` with, before it in the same batch, the event recording what
 * it changes, if anything. Returns whether `write` changed the row.
 */
async function writeWithChange(
  database: D1Database,
  write: D1PreparedStatement,
  change: {
    cause: SubscriptionChangeCause;
    guard: BillingGuard;
    organizationId: string;
    stored: StoredSubscription;
  } | null,
) {
  const results = await database.batch(
    change
      ? [
          subscriptionChangeStatement(
            database,
            change.cause,
            change.organizationId,
            change.stored,
            change.guard,
          ),
          write,
        ]
      : [write],
  );
  return Number(results.at(-1)?.meta.changes) > 0;
}

/**
 * Cancels the subscription in Stripe and stores it. `cause` is set when a
 * new Checkout replaced it; without one, as when deleting an organization,
 * Stripe's confirmation records no event of its own.
 */
export async function cancelStripeSubscription(
  environment: SubscriptionEnvironment,
  organizationId: string,
  subscriptionId: string,
  cause: SubscriptionChangeCause | null = null,
) {
  await withSubscriptionSyncLock(environment.DB, subscriptionId, async () => {
    const subscription = await deleteStripeSubscription(
      environment,
      subscriptionId,
    );
    await persistSubscription(
      environment,
      subscription,
      Math.floor(Date.now() / 1000),
      cause,
      organizationId,
    );
  });
}

async function deleteStripeSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  subscriptionId: string,
) {
  const subscription = parseStripeSubscription(
    await stripeDelete(
      environment,
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    ),
  );
  if (subscription.status !== "canceled") {
    throw new StripeApiError("Stripe did not cancel the subscription.", 502);
  }
  return subscription;
}

async function organizationForStripeRecord(
  database: D1Database,
  subscriptionId: string,
  customerId: string,
) {
  const row = await database
    .prepare(
      `SELECT organization_id FROM organization_billing
       WHERE stripe_subscription_id = ? OR stripe_customer_id = ?
       LIMIT 1`,
    )
    .bind(subscriptionId, customerId)
    .first<{ organization_id: string }>();
  return row?.organization_id;
}
