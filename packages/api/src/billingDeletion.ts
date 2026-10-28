import { expireOrReloadCheckoutSession } from "./billingCheckout";
import {
  type BillingRow,
  billingColumns,
  clearCheckoutClaim,
  clearPendingCheckout,
  organizationExists,
} from "./billingRecords";
import {
  cancelStripeSubscription,
  type SubscriptionEnvironment,
  terminalSubscriptionStatuses,
} from "./billingSubscriptions";
import { StripeApiError, stripeGet } from "./stripe";
import {
  optionalExpandableId,
  parseStripeCheckoutSession,
} from "./stripePayload";
import type { Bindings } from "./types";

const checkoutDeletionLeaseSeconds = 5 * 60;

export async function cancelOrganizationSubscription(
  environment: SubscriptionEnvironment,
  organizationId: string,
) {
  const deletion = await disableCheckoutForDeletion(
    environment.DB,
    organizationId,
  );
  if (!deletion) {
    if (!(await organizationExists(environment.DB, organizationId))) {
      return { canceled: false, checkoutGuard: null };
    }
    throw new StripeApiError(
      "Organization deletion is already in progress.",
      409,
    );
  }
  const { checkoutGuard, record } = deletion;
  try {
    const pendingSubscriptionId = await resolvePendingCheckoutForDeletion(
      environment,
      record,
    );
    const subscriptionIds = new Set<string>();
    if (
      record?.stripe_subscription_id &&
      !terminalSubscriptionStatuses.has(record.stripe_status ?? "")
    ) {
      subscriptionIds.add(record.stripe_subscription_id);
    }
    if (pendingSubscriptionId) subscriptionIds.add(pendingSubscriptionId);
    for (const subscriptionId of subscriptionIds) {
      await cancelStripeSubscription(
        environment,
        organizationId,
        subscriptionId,
      );
    }
    await forgetPendingCheckout(environment.DB, organizationId);
    return {
      canceled:
        subscriptionIds.size > 0 ||
        Boolean(record?.pending_checkout_session_id),
      checkoutGuard,
    };
  } catch (cause) {
    await enableCheckoutAfterFailedDeletion(
      environment.DB,
      organizationId,
      checkoutGuard,
    );
    throw cause;
  }
}

export async function recoverCheckoutAfterFailedDeletion(
  database: D1Database,
  organizationId: string,
  checkoutGuard: string | null,
) {
  if (!checkoutGuard) return false;
  const recovered = await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at = ?
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE id = ? AND deletedAt IS NULL
         )`,
    )
    .bind(
      new Date().toISOString(),
      organizationId,
      checkoutGuard,
      organizationId,
    )
    .run();
  return Number(recovered.meta.changes) === 1;
}

async function resolvePendingCheckoutForDeletion(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  record: BillingRow | null,
) {
  if (!record?.pending_checkout_session_id) return null;
  const sessionId = record.pending_checkout_session_id;
  let session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
  if (session.status === "open") {
    session = await expireOrReloadCheckoutSession(environment, sessionId);
  }
  if (session.status === "expired") return null;
  if (session.status === "complete") {
    const subscriptionId = optionalExpandableId(session.subscription);
    if (subscriptionId) return subscriptionId;
  }
  throw new StripeApiError(
    "Stripe Checkout could not be resolved before organization deletion.",
    409,
  );
}

async function disableCheckoutForDeletion(
  database: D1Database,
  organizationId: string,
) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const now = new Date(nowSeconds * 1_000).toISOString();
  const expiresAt = nowSeconds + checkoutDeletionLeaseSeconds;
  const checkoutGuard = crypto.randomUUID();
  const record = await database
    .prepare(
      `INSERT INTO organization_billing
       (organization_id, checkout_disabled_at,
        checkout_disabled_expires_at, updated_at)
       SELECT id, ?, ?, ? FROM organization WHERE id = ?
       ON CONFLICT (organization_id) DO UPDATE SET
         checkout_disabled_at = excluded.checkout_disabled_at,
         checkout_disabled_expires_at =
           excluded.checkout_disabled_expires_at,
         ${clearCheckoutClaim},
         updated_at = excluded.updated_at
       WHERE organization_billing.checkout_disabled_at IS NULL
          OR COALESCE(
               organization_billing.checkout_disabled_expires_at,
               0
             ) <= ?
       RETURNING ${billingColumns}`,
    )
    .bind(checkoutGuard, expiresAt, now, organizationId, nowSeconds)
    .first<BillingRow>();
  return record?.checkout_disabled_at === checkoutGuard
    ? { checkoutGuard, record }
    : null;
}

async function enableCheckoutAfterFailedDeletion(
  database: D1Database,
  organizationId: string,
  checkoutGuard: string | null,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at IS ?`,
    )
    .bind(new Date().toISOString(), organizationId, checkoutGuard)
    .run();
}

async function forgetPendingCheckout(
  database: D1Database,
  organizationId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET ${clearPendingCheckout},
           updated_at = ?
       WHERE organization_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId)
    .run();
}
