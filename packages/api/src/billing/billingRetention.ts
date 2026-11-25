import {
  maintenanceActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";
import type { Bindings } from "../types";
import { reconcilePendingCheckoutEntitlements } from "./billingCheckoutSync";
import {
  freeRetentionDays,
  lapsedRetentionGraceDays,
  paidStatusList,
} from "./billingEntitlements";

const retentionBatchSize = 100;
const retentionBatchesPerInvocation = 5;
const dayMilliseconds = 24 * 60 * 60 * 1_000;

/** Completed forms outside a free organization's window, with their organization. */
const expiredForms = `SELECT form.id, form.organization_id,
         COALESCE(form.completed_at, form.updated_at) AS completed_at
  FROM forms AS form
  JOIN organization AS organization
    ON organization.id = form.organization_id
  LEFT JOIN organization_billing AS billing
    ON billing.organization_id = form.organization_id
  WHERE organization.deletedAt IS NULL
    AND form.status = 'completed'
    AND billing.pending_checkout_session_id IS NULL
    AND NOT (
      billing.checkout_claim_id IS NOT NULL
      AND COALESCE(billing.checkout_claim_expires_at, 0) > unixepoch()
    )
    AND NOT (
      billing.checkout_disabled_at IS NOT NULL
      AND COALESCE(billing.checkout_disabled_expires_at, 0) > unixepoch()
    )
    AND NOT (
      billing.paid_ended_at IS NOT NULL
      AND datetime(billing.paid_ended_at) >= datetime(?)
    )
    AND datetime(COALESCE(form.completed_at, form.updated_at)) <
        datetime(?)
    AND COALESCE(billing.stripe_status, '') NOT IN ${paidStatusList}`;

/**
 * Permanently remove form history outside a free organization's window.
 * Organizations whose paid plan ended after `paidEndedAfter` are still in
 * their grace period and keep all history. Each batch records, per
 * organization, one `organization.form_runs_purged` event by the job with
 * the number of runs removed, in the transaction that removes them.
 */
export async function purgeExpiredFreeFormRuns(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  runId: string,
  retainedAfter = new Date(
    Date.now() - freeRetentionDays * dayMilliseconds,
  ).toISOString(),
  paidEndedAfter = new Date(
    Date.now() - lapsedRetentionGraceDays * dayMilliseconds,
  ).toISOString(),
) {
  const proPriceId = environment.STRIPE_PRO_PRICE_ID;
  if (!proPriceId) {
    throw new Error(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
  }
  await reconcilePendingCheckoutEntitlements(environment);
  let deleted = 0;
  for (let batch = 0; batch < retentionBatchesPerInvocation; batch += 1) {
    const purged = await purgeRetentionBatch(
      environment.DB,
      runId,
      retainedAfter,
      paidEndedAfter,
    );
    deleted += purged;
    if (purged < retentionBatchSize) return deleted;
  }
  return deleted;
}

/**
 * What `purgeExpiredFreeFormRuns` would purge now; it changes nothing. A run
 * first settles pending checkouts with Stripe, which a dry run skips, so an
 * organization mid-checkout is left out of both.
 */
export async function previewExpiredFreeFormRunPurge(
  environment: Pick<Bindings, "DB" | "STRIPE_PRO_PRICE_ID">,
  retainedAfter = new Date(
    Date.now() - freeRetentionDays * dayMilliseconds,
  ).toISOString(),
  paidEndedAfter = new Date(
    Date.now() - lapsedRetentionGraceDays * dayMilliseconds,
  ).toISOString(),
) {
  if (!environment.STRIPE_PRO_PRICE_ID) {
    throw new Error(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
  }
  const row = await environment.DB.prepare(
    `SELECT count(*) AS eligible,
            count(DISTINCT expired.organization_id) AS organizations
     FROM (${expiredForms}) AS expired`,
  )
    .bind(paidEndedAfter, retainedAfter)
    .first<{ eligible: number; organizations: number }>();
  const eligible = row?.eligible ?? 0;
  return {
    eligible,
    organizations: row?.organizations ?? 0,
    wouldPurge: Math.min(
      eligible,
      retentionBatchSize * retentionBatchesPerInvocation,
    ),
  };
}

async function purgeRetentionBatch(
  database: D1Database,
  runId: string,
  retainedAfter: string,
  paidEndedAfter: string,
) {
  const candidates = await database
    .prepare(
      `${expiredForms}
       ORDER BY COALESCE(form.completed_at, form.updated_at) ASC, form.id ASC
       LIMIT ?`,
    )
    .bind(paidEndedAfter, retainedAfter, retentionBatchSize)
    .all<{ id: string }>();
  if (!candidates.results.length) return 0;
  const ids = JSON.stringify(candidates.results.map(({ id }) => id));
  const [, result] = await database.batch<{ id: string }>([
    // The subject is the batch's first run in the organization: a run is
    // purged once, so each batch's event stays distinct within the job run.
    systemActivityRowsStatement(
      database,
      maintenanceActor("purgeExpiredFreeFormRuns", runId),
      new Date().toISOString(),
      {
        bindings: [
          retainedAfter,
          freeRetentionDays,
          paidEndedAfter,
          retainedAfter,
          ids,
        ],
        sql: `SELECT organization.id AS organization_id,
                     'organization' AS root_type, organization.id AS root_id,
                     organization.name AS root_label,
                     'form_run' AS subject_type, MIN(expired.id) AS subject_id,
                     'organization.form_runs_purged' AS action,
                     json_object('count', COUNT(*), 'completedBefore', ?,
                                 'retentionDays', ?) AS details
              FROM (${expiredForms}) AS expired
              JOIN organization ON organization.id = expired.organization_id
              WHERE expired.id IN (SELECT value FROM json_each(?))
              GROUP BY organization.id`,
      },
    ),
    database
      .prepare(
        `DELETE FROM forms
         WHERE id IN (SELECT value FROM json_each(?))
           AND id IN (SELECT id FROM (${expiredForms}))
         RETURNING id`,
      )
      .bind(ids, paidEndedAfter, retainedAfter),
  ]);
  return result?.results.length ?? 0;
}
