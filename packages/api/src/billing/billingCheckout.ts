import { type ActivityActor, activityBatch } from "../shared/activity";
import type { Bindings } from "../types";
import { paidStatusList } from "./billingEntitlements";
import {
  type BillingRow,
  clearCheckoutClaim,
  clearPendingCheckout,
  findBilling,
} from "./billingRecords";
import { StripeApiError, stripeGet, stripePost } from "./stripe";
import {
  parseStripeCheckoutSession,
  type StripeCheckoutSession,
} from "./stripePayload";

const checkoutDurationSeconds = 35 * 60;

export async function claimCheckout(
  database: D1Database,
  organizationId: string,
  priceId: string,
  quantity: number,
  nowSeconds: number,
) {
  const claimId = crypto.randomUUID();
  const expiresAt = nowSeconds + checkoutDurationSeconds;
  const claimed = await database
    .prepare(
      `INSERT INTO organization_billing
       (organization_id, checkout_claim_id, checkout_claim_customer_id,
        checkout_claim_price_id, checkout_claim_quantity,
        checkout_claim_expires_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET
         checkout_claim_id = excluded.checkout_claim_id,
         checkout_claim_customer_id =
           organization_billing.stripe_customer_id,
         checkout_claim_price_id = excluded.checkout_claim_price_id,
         checkout_claim_quantity = excluded.checkout_claim_quantity,
         checkout_claim_expires_at = excluded.checkout_claim_expires_at,
         checkout_disabled_at = NULL,
         checkout_disabled_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE NOT (
           COALESCE(organization_billing.stripe_price_id, '') = ?
           AND COALESCE(organization_billing.stripe_status, '') IN
             ${paidStatusList}
         )
         AND COALESCE(organization_billing.pending_checkout_expires_at, 0) <= ?
         AND COALESCE(organization_billing.checkout_claim_expires_at, 0) <= ?
         AND (
           organization_billing.checkout_disabled_at IS NULL
           OR COALESCE(
                organization_billing.checkout_disabled_expires_at,
                0
              ) <= ?
         )`,
    )
    .bind(
      organizationId,
      claimId,
      priceId,
      quantity,
      expiresAt,
      new Date().toISOString(),
      priceId,
      nowSeconds,
      nowSeconds,
      nowSeconds,
    )
    .run();
  const record = await findBilling(database, organizationId);
  return {
    id: claimId,
    owned:
      Number(claimed.meta.changes) > 0 && record?.checkout_claim_id === claimId,
    record,
  };
}

export function completeCheckoutClaim(
  record: BillingRow | null,
  claimId: string,
): record is BillingRow & {
  checkout_claim_expires_at: number;
  checkout_claim_id: string;
  checkout_claim_price_id: string;
  checkout_claim_quantity: number;
} {
  return Boolean(
    record?.checkout_claim_id === claimId &&
      record.checkout_claim_price_id &&
      record.checkout_claim_quantity &&
      record.checkout_claim_expires_at,
  );
}

export async function releaseCheckoutClaim(
  database: D1Database,
  organizationId: string,
  claimId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET ${clearCheckoutClaim},
           updated_at = ?
       WHERE organization_id = ? AND checkout_claim_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId, claimId)
    .run();
}

export async function attachCheckoutSessionToClaim(
  database: D1Database,
  organizationId: string,
  claimId: string,
  sessionId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?, pending_checkout_url = NULL,
           pending_checkout_expires_at = checkout_claim_expires_at,
           pending_checkout_retry_at = NULL,
           ${clearCheckoutClaim}, updated_at = ?
       WHERE organization_id = ? AND checkout_claim_id = ?
         AND checkout_disabled_at IS NULL`,
    )
    .bind(sessionId, new Date().toISOString(), organizationId, claimId)
    .run();
}

/**
 * Stores the opened session as the organization's pending Checkout and, in the
 * same batch, records who started it. A session is recorded once, even when a
 * webhook attached it to the claim first.
 */
export async function storePendingCheckout(
  database: D1Database,
  organizationId: string,
  claimId: string,
  checkout: StripeCheckoutSession,
  started: { actor: ActivityActor; priceId: string; quantity: number },
) {
  const now = new Date().toISOString();
  const [stored] = await activityBatch(database, started.actor.apiKey, [
    database
      .prepare(
        `UPDATE organization_billing
         SET pending_checkout_session_id = ?, pending_checkout_url = ?,
             pending_checkout_expires_at = ?, pending_checkout_retry_at = NULL,
             ${clearCheckoutClaim},
             updated_at = ?
         WHERE organization_id = ?
           AND (checkout_claim_id = ? OR pending_checkout_session_id = ?)`,
      )
      .bind(
        checkout.id,
        checkout.url,
        checkout.expires_at,
        now,
        organizationId,
        claimId,
        checkout.id,
      ),
    database
      .prepare(
        `INSERT INTO activity_events (
           organization_id, root_type, root_id, root_label, subject_type,
           subject_id, action, actor_user_id, actor_name, actor_email,
           occurred_at, details
         )
         SELECT organization.id, 'organization_billing', organization.id,
                organization.name, 'billing_checkout', ?,
                'billing.checkout_started', actor.id, actor.name, actor.email,
                ?, json_object('checkoutSessionId', ?, 'priceId', ?,
                               'quantity', ?)
         FROM organization JOIN user AS actor ON actor.id = ?
         WHERE organization.id = ? AND changes() > 0
           AND NOT EXISTS (
             SELECT 1 FROM activity_events
             WHERE organization_id = organization.id
               AND action = 'billing.checkout_started' AND subject_id = ?
           )`,
      )
      .bind(
        checkout.id,
        now,
        checkout.id,
        started.priceId,
        started.quantity,
        started.actor.userId,
        organizationId,
        checkout.id,
      ),
  ]);
  return Number(stored?.meta.changes) > 0;
}

export async function clearPendingCheckoutIfCurrent(
  database: D1Database,
  organizationId: string,
  sessionId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET ${clearPendingCheckout},
           updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId, sessionId)
    .run();
}

export function activePendingCheckout(
  record: BillingRow | null,
  nowSeconds: number,
) {
  if (
    !record?.pending_checkout_session_id ||
    !record.pending_checkout_expires_at ||
    record.pending_checkout_expires_at <= nowSeconds
  ) {
    return null;
  }
  return {
    id: record.pending_checkout_session_id,
    url: record.pending_checkout_url,
  };
}

export function stalePendingCheckoutId(
  record: BillingRow | null,
  nowSeconds: number,
) {
  return record?.pending_checkout_session_id &&
    (record.pending_checkout_expires_at ?? 0) <= nowSeconds
    ? record.pending_checkout_session_id
    : null;
}

export function checkoutDeletionInProgress(
  record: BillingRow | null,
  nowSeconds: number,
) {
  return Boolean(
    record?.checkout_disabled_at &&
      record.checkout_disabled_expires_at &&
      record.checkout_disabled_expires_at > nowSeconds,
  );
}

export async function clearExpiredCheckoutDeletionLease(
  database: D1Database,
  organizationId: string,
  nowSeconds: number,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ?
         AND checkout_disabled_at IS NOT NULL
         AND COALESCE(checkout_disabled_expires_at, 0) <= ?`,
    )
    .bind(
      new Date(nowSeconds * 1_000).toISOString(),
      organizationId,
      nowSeconds,
    )
    .run();
}

/** What a created Checkout opens with, or null when Stripe left it out. */
export function openedCheckout(
  checkout: StripeCheckoutSession,
  publishableKey: string | null,
) {
  if (checkout.status !== "open" || !checkout.id || !checkout.expires_at)
    return null;
  if (publishableKey === null)
    return checkout.url ? { url: checkout.url } : null;
  return checkout.client_secret
    ? { clientSecret: checkout.client_secret, publishableKey }
    : null;
}

/**
 * Inline Checkout needs a publishable key from the same Stripe mode as the
 * secret key. Without one, Checkout stays on Stripe's hosted page.
 */
export function checkoutPublishableKey(
  environment: Pick<Bindings, "STRIPE_PUBLISHABLE_KEY" | "STRIPE_SECRET_KEY">,
) {
  const mode = /^(?:sk|rk)_(live|test)_/.exec(
    environment.STRIPE_SECRET_KEY ?? "",
  )?.[1];
  const publishableKey = environment.STRIPE_PUBLISHABLE_KEY ?? "";
  return mode && publishableKey.startsWith(`pk_${mode}_`)
    ? publishableKey
    : null;
}

/**
 * Builds a hosted Checkout, or an inline one when `inlineEmail` is set. Inline
 * Checkout returns to the same success URL but has no cancel page, and it needs
 * an email up front because the page collects only payment details.
 */
export function checkoutParameters(
  origin: string,
  organizationId: string,
  priceId: string,
  claim: BillingRow & { checkout_claim_id: string },
  inlineEmail: string | null,
  startedBy: string,
) {
  const successUrl = `${origin}/organization/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const parameters = new URLSearchParams({
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(claim.checkout_claim_quantity),
    "metadata[checkout_claim_id]": claim.checkout_claim_id,
    "metadata[organization_id]": organizationId,
    // The Balebase user who started Checkout, so Stripe's records name them.
    "metadata[started_by_user_id]": startedBy,
    "subscription_data[metadata][checkout_claim_id]": claim.checkout_claim_id,
    "subscription_data[metadata][organization_id]": organizationId,
    "subscription_data[metadata][started_by_user_id]": startedBy,
    client_reference_id: organizationId,
    expires_at: String(claim.checkout_claim_expires_at),
    mode: "subscription",
  });
  if (inlineEmail === null) {
    parameters.set(
      "cancel_url",
      `${origin}/organization/billing?checkout=canceled`,
    );
    parameters.set("success_url", successUrl);
  } else {
    parameters.set("return_url", successUrl);
    parameters.set("ui_mode", "elements");
  }
  if (claim.checkout_claim_customer_id) {
    parameters.set("customer", claim.checkout_claim_customer_id);
  } else if (inlineEmail !== null) {
    parameters.set("customer_email", inlineEmail);
  }
  return parameters;
}

export async function expireCheckoutSession(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  sessionId: string,
) {
  parseStripeCheckoutSession(
    await stripePost(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      new URLSearchParams(),
    ),
  );
}

export async function expireOrReloadCheckoutSession(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  sessionId: string,
) {
  try {
    return parseStripeCheckoutSession(
      await stripePost(
        environment,
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        new URLSearchParams(),
      ),
    );
  } catch (cause) {
    if (
      !(cause instanceof StripeApiError) ||
      (cause.status !== 400 && cause.status !== 409)
    ) {
      throw cause;
    }
    return parseStripeCheckoutSession(
      await stripeGet(
        environment,
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      ),
    );
  }
}
