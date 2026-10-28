import type { CheckoutOutcome } from "@balebase/validators/billing";
import {
  clearPendingCheckoutIfCurrent,
  expireOrReloadCheckoutSession,
} from "./billingCheckout";
import {
  refreshSubscription,
  type SubscriptionEnvironment,
} from "./billingSubscriptions";
import { StripeApiError, stripeGet } from "./stripe";
import {
  optionalExpandableId,
  parseStripeCheckoutSession,
} from "./stripePayload";

const pendingCheckoutReconciliationLimit = 25;
const pendingCheckoutRetrySeconds = 5 * 60;

export async function confirmCheckoutSession(
  environment: SubscriptionEnvironment,
  organizationId: string,
  sessionId: string,
): Promise<CheckoutOutcome> {
  const query = new URLSearchParams();
  query.append("expand[]", "subscription");
  const session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      query,
    ),
  );
  if (session.client_reference_id !== organizationId) {
    throw new StripeApiError(
      "Checkout is not complete for this organization.",
      409,
    );
  }
  if (session.status !== "complete") return "incomplete";
  const subscriptionId = optionalExpandableId(session.subscription);
  if (!subscriptionId) {
    throw new StripeApiError("Checkout did not create a subscription.", 409);
  }
  const persisted = await refreshSubscription(
    environment,
    subscriptionId,
    Math.floor(Date.now() / 1000),
    organizationId,
    sessionId,
    session.metadata?.checkout_claim_id,
  );
  if (!persisted) {
    throw new StripeApiError("Checkout did not create a subscription.", 409);
  }
  return "complete";
}

export async function reconcilePendingCheckoutEntitlements(
  environment: SubscriptionEnvironment,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const pending = await environment.DB.prepare(
    `SELECT organization_id, pending_checkout_session_id
     FROM organization_billing
     WHERE pending_checkout_session_id IS NOT NULL
       AND COALESCE(pending_checkout_expires_at, 0) <= ?
       AND COALESCE(pending_checkout_retry_at, 0) <= ?
     ORDER BY pending_checkout_retry_at IS NOT NULL ASC,
              pending_checkout_retry_at ASC,
              pending_checkout_expires_at ASC,
              organization_id ASC
     LIMIT ?`,
  )
    .bind(nowSeconds, nowSeconds, pendingCheckoutReconciliationLimit)
    .all<{
      organization_id: string;
      pending_checkout_session_id: string;
    }>();
  for (const row of pending.results) {
    try {
      await reconcilePendingCheckoutEntitlement(
        environment,
        row.organization_id,
        row.pending_checkout_session_id,
        nowSeconds,
      );
    } catch (cause) {
      await deferPendingCheckoutReconciliation(
        environment.DB,
        row.organization_id,
        row.pending_checkout_session_id,
        nowSeconds,
      ).catch((retryCause: unknown) => {
        console.error(
          "Pending Checkout retry could not be scheduled",
          row.organization_id,
          retryCause,
        );
      });
      console.error(
        "Pending Checkout reconciliation failed",
        row.organization_id,
        cause,
      );
    }
  }
}

async function deferPendingCheckoutReconciliation(
  database: D1Database,
  organizationId: string,
  sessionId: string,
  nowSeconds: number,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_retry_at = ?, updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
    .bind(
      nowSeconds + pendingCheckoutRetrySeconds,
      new Date(nowSeconds * 1_000).toISOString(),
      organizationId,
      sessionId,
    )
    .run();
}

export async function reconcilePendingCheckoutEntitlement(
  environment: SubscriptionEnvironment,
  organizationId: string,
  sessionId: string,
  nowSeconds: number,
) {
  let session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
  const sessionOrganizationId =
    session.client_reference_id ?? session.metadata?.organization_id;
  if (sessionOrganizationId !== organizationId) {
    throw new StripeApiError(
      "Pending Checkout does not belong to its organization.",
      409,
    );
  }
  if (
    session.status === "open" &&
    (!session.expires_at || session.expires_at <= nowSeconds)
  ) {
    session = await expireOrReloadCheckoutSession(environment, sessionId);
  }
  if (session.status === "expired") {
    await clearPendingCheckoutIfCurrent(
      environment.DB,
      organizationId,
      sessionId,
    );
    return;
  }
  if (session.status === "complete") {
    const subscriptionId = optionalExpandableId(session.subscription);
    if (
      !subscriptionId ||
      !(await refreshSubscription(
        environment,
        subscriptionId,
        nowSeconds,
        organizationId,
        sessionId,
        session.metadata?.checkout_claim_id,
      ))
    ) {
      throw new StripeApiError(
        "Pending Checkout entitlement could not be reconciled.",
        409,
      );
    }
    return;
  }
  if (
    session.status === "open" &&
    session.expires_at &&
    session.expires_at > nowSeconds
  ) {
    await environment.DB.prepare(
      `UPDATE organization_billing
       SET pending_checkout_expires_at = ?, pending_checkout_retry_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
      .bind(
        session.expires_at,
        new Date().toISOString(),
        organizationId,
        sessionId,
      )
      .run();
    return;
  }
  throw new StripeApiError(
    "Pending Checkout entitlement could not be reconciled.",
    409,
  );
}
