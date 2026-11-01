import type { ActivityCausation } from "../shared/systemActivity";
import type { Bindings } from "../types";
import {
  isPaidBilling,
  type ProPriceEnvironment,
  paidStatusList,
} from "./billingEntitlements";
import { seatChangeStatement } from "./billingProviderActivity";
import { type BillingRow, countMembers, findBilling } from "./billingRecords";
import { StripeApiError, stripeGet, stripePost } from "./stripe";
import { parseStripeSeatItemResponse } from "./stripePayload";

const subscriptionSeatReconciliationLimit = 25;
const subscriptionSyncClaimSeconds = 2 * 60;

type SeatEnvironment = ProPriceEnvironment &
  Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">;

/**
 * Sets the subscription's seat quantity to the organization's member count,
 * in Stripe and in storage. A membership change asks for it; the hourly
 * reconciliation (`reconciliationRunId`, its job run) also verifies Stripe's
 * quantity. A stored change records `billing.seats_changed` by Stripe.
 */
export async function syncOrganizationSeats(
  environment: SeatEnvironment,
  organizationId: string,
  verifyStripeQuantity = false,
  reconciliationRunId?: string,
) {
  const initialRecord = await findBilling(environment.DB, organizationId);
  if (
    !isPaidBilling(initialRecord, environment) ||
    !initialRecord?.stripe_subscription_item_id
  ) {
    return false;
  }
  const lockId = subscriptionLockId(initialRecord);
  return withSubscriptionSyncLock(
    environment.DB,
    lockId,
    async () =>
      syncOrganizationSeatsLocked(
        environment,
        organizationId,
        lockId,
        verifyStripeQuantity,
        reconciliationRunId,
      ),
    true,
  );
}

async function syncOrganizationSeatsLocked(
  environment: SeatEnvironment,
  organizationId: string,
  lockId: string,
  verifyStripeQuantity: boolean,
  reconciliationRunId: string | undefined,
) {
  const record = await findBilling(environment.DB, organizationId);
  if (
    !isPaidBilling(record, environment) ||
    !record?.stripe_subscription_item_id ||
    subscriptionLockId(record) !== lockId
  ) {
    return false;
  }
  const quantity = Math.max(
    1,
    await countMembers(environment.DB, organizationId),
  );
  if (quantity === record.seat_quantity && !verifyStripeQuantity) return false;
  const change = (causation: ActivityCausation | null): SeatChange => ({
    causation: reconciliationRunId
      ? { id: reconciliationRunId, type: "job_run" }
      : causation,
    quantity,
    source: verifyStripeQuantity ? "reconciliation" : "membership",
  });
  if (verifyStripeQuantity) {
    const stripeItem = parseStripeSeatItemResponse(
      await stripeGet(
        environment,
        `/v1/subscription_items/${encodeURIComponent(record.stripe_subscription_item_id)}`,
      ),
    );
    if (
      stripeItem.id === record.stripe_subscription_item_id &&
      stripeItem.quantity === quantity
    ) {
      if (record.seat_quantity !== quantity) {
        await updateStoredSeatQuantity(
          environment.DB,
          organizationId,
          record.stripe_subscription_item_id,
          change(null),
        );
      }
      return false;
    }
  }
  const idempotencyKey = [
    "seats",
    organizationId,
    record.stripe_subscription_item_id,
    record.seat_quantity,
    quantity,
    record.updated_at,
  ].join(":");
  const stripeItem = parseStripeSeatItemResponse(
    await stripePost(
      environment,
      `/v1/subscription_items/${encodeURIComponent(record.stripe_subscription_item_id)}`,
      new URLSearchParams({
        proration_behavior: "create_prorations",
        quantity: String(quantity),
      }),
      idempotencyKey,
    ),
  );
  if (
    stripeItem.id !== record.stripe_subscription_item_id ||
    stripeItem.quantity !== quantity
  ) {
    throw new StripeApiError("Stripe did not update the seat quantity.", 502);
  }
  await updateStoredSeatQuantity(
    environment.DB,
    organizationId,
    record.stripe_subscription_item_id,
    // The request Stripe applied, whose key it deduplicates by too.
    change({ id: idempotencyKey, type: "stripe_request" }),
  );
  return true;
}

function subscriptionLockId(record: BillingRow) {
  return (
    record.stripe_subscription_id ??
    `subscription-item:${record.stripe_subscription_item_id ?? "missing"}`
  );
}

export async function reconcileSubscriptionSeats(
  environment: SeatEnvironment,
  runId?: string,
) {
  const rows = await environment.DB.prepare(
    `SELECT organization_id
     FROM organization_billing
     WHERE stripe_subscription_item_id IS NOT NULL
       AND stripe_status IN ${paidStatusList}
     ORDER BY last_reconciled_at IS NOT NULL ASC,
              last_reconciled_at ASC,
              organization_id ASC
     LIMIT ?`,
  )
    .bind(subscriptionSeatReconciliationLimit)
    .all<{ organization_id: string }>();
  let firstFailure: unknown;
  for (const row of rows.results) {
    try {
      await syncOrganizationSeats(
        environment,
        row.organization_id,
        true,
        runId,
      );
    } catch (cause) {
      firstFailure ??= cause;
    } finally {
      try {
        await environment.DB.prepare(
          `UPDATE organization_billing SET last_reconciled_at = ?
           WHERE organization_id = ?`,
        )
          .bind(new Date().toISOString(), row.organization_id)
          .run();
      } catch (cause) {
        firstFailure ??= cause;
      }
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return { checked: rows.results.length };
}

interface SeatChange {
  causation: ActivityCausation | null;
  quantity: number;
  source: "membership" | "reconciliation";
}

/** Stores the quantity Stripe confirmed, with its event when it changed. */
async function updateStoredSeatQuantity(
  database: D1Database,
  organizationId: string,
  subscriptionItemId: string,
  change: SeatChange,
) {
  await database.batch([
    seatChangeStatement(
      database,
      change.causation,
      organizationId,
      subscriptionItemId,
      change.quantity,
      change.source,
    ),
    database
      .prepare(
        `UPDATE organization_billing
         SET seat_quantity = ?, updated_at = ?
         WHERE organization_id = ? AND stripe_subscription_item_id = ?`,
      )
      .bind(
        change.quantity,
        new Date().toISOString(),
        organizationId,
        subscriptionItemId,
      ),
  ]);
}

export async function withSubscriptionSyncLock<T>(
  database: D1Database,
  subscriptionId: string,
  action: () => Promise<T>,
  waitForLock = false,
) {
  const claimId = crypto.randomUUID();
  await claimSubscriptionSyncLock(
    database,
    subscriptionId,
    claimId,
    waitForLock,
  );
  try {
    return await action();
  } finally {
    await database
      .prepare(
        `DELETE FROM stripe_subscription_sync_locks
         WHERE subscription_id = ? AND claim_id = ?`,
      )
      .bind(subscriptionId, claimId)
      .run();
  }
}

async function claimSubscriptionSyncLock(
  database: D1Database,
  subscriptionId: string,
  claimId: string,
  waitForLock: boolean,
) {
  const waitDeadline = Date.now() + 10_000;
  while (true) {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const claimed = await database
      .prepare(
        `INSERT INTO stripe_subscription_sync_locks
         (subscription_id, claim_id, claim_expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (subscription_id) DO UPDATE SET
           claim_id = excluded.claim_id,
           claim_expires_at = excluded.claim_expires_at
         WHERE stripe_subscription_sync_locks.claim_expires_at <= ?`,
      )
      .bind(
        subscriptionId,
        claimId,
        nowSeconds + subscriptionSyncClaimSeconds,
        nowSeconds,
      )
      .run();
    if (Number(claimed.meta.changes) > 0) return;
    if (!waitForLock || Date.now() >= waitDeadline) {
      throw new Error(
        "Stripe subscription synchronization is already running.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
