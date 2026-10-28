export interface BillingRow {
  cancel_at_period_end: number;
  checkout_claim_customer_id: string | null;
  checkout_claim_expires_at: number | null;
  checkout_claim_id: string | null;
  checkout_claim_price_id: string | null;
  checkout_claim_quantity: number | null;
  checkout_disabled_at: string | null;
  checkout_disabled_expires_at: number | null;
  current_period_end: string | null;
  last_reconciled_at: string | null;
  pending_checkout_expires_at: number | null;
  pending_checkout_retry_at: number | null;
  pending_checkout_session_id: string | null;
  pending_checkout_url: string | null;
  seat_quantity: number;
  stripe_customer_id: string | null;
  stripe_event_created: number;
  stripe_price_id: string | null;
  stripe_status: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  updated_at: string;
}

/** The `organization_billing` columns a `BillingRow` holds. */
export const billingColumns = `stripe_customer_id, stripe_subscription_id,
  stripe_subscription_item_id, stripe_price_id, stripe_status,
  seat_quantity, cancel_at_period_end, current_period_end,
  stripe_event_created, checkout_claim_id,
  checkout_claim_customer_id, checkout_claim_price_id,
  checkout_claim_quantity, checkout_claim_expires_at,
  checkout_disabled_at, checkout_disabled_expires_at,
  pending_checkout_session_id, pending_checkout_url,
  pending_checkout_expires_at, pending_checkout_retry_at,
  last_reconciled_at, updated_at`;

const checkoutClaimColumns = [
  "checkout_claim_id",
  "checkout_claim_customer_id",
  "checkout_claim_price_id",
  "checkout_claim_quantity",
  "checkout_claim_expires_at",
];
const pendingCheckoutColumns = [
  "pending_checkout_session_id",
  "pending_checkout_url",
  "pending_checkout_expires_at",
  "pending_checkout_retry_at",
];

/** SET assignments that release the Checkout claim. */
export const clearCheckoutClaim = checkoutClaimColumns
  .map((column) => `${column} = NULL`)
  .join(", ");

/** SET assignments that forget the pending Checkout session. */
export const clearPendingCheckout = pendingCheckoutColumns
  .map((column) => `${column} = NULL`)
  .join(", ");

const settledCheckoutColumns = [
  ...checkoutClaimColumns,
  ...pendingCheckoutColumns,
];

/**
 * SET assignments that clear the claim and pending session only when the
 * pending session is the bound one. Bind that session ID once per
 * `settledCheckoutBindings`.
 */
export const clearSettledCheckout = settledCheckoutColumns
  .map(
    (column) =>
      `${column} = CASE WHEN pending_checkout_session_id = ? THEN NULL ELSE ${column} END`,
  )
  .join(",\n");
export const settledCheckoutBindings = settledCheckoutColumns.length;

export async function findBilling(
  database: D1Database,
  organizationId: string,
) {
  return database
    .prepare(
      `SELECT ${billingColumns}
       FROM organization_billing WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first<BillingRow>();
}

export async function countMembers(
  database: D1Database,
  organizationId: string,
) {
  const row = await database
    .prepare(`SELECT COUNT(*) AS count FROM member WHERE organizationId = ?`)
    .bind(organizationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function organizationExists(
  database: D1Database,
  organizationId: string,
) {
  return Boolean(
    await database
      .prepare(`SELECT id FROM organization WHERE id = ? AND deletedAt IS NULL`)
      .bind(organizationId)
      .first(),
  );
}
