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

/** Completed audits outside a free organization's window, with their organization. */
const expiredAudits = `SELECT audit.id, audit.organization_id,
         COALESCE(audit.completed_at, audit.updated_at) AS completed_at
  FROM audits AS audit
  JOIN organization AS organization
    ON organization.id = audit.organization_id
  LEFT JOIN organization_billing AS billing
    ON billing.organization_id = audit.organization_id
  WHERE organization.deletedAt IS NULL
    AND audit.status = 'completed'
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
    AND datetime(COALESCE(audit.completed_at, audit.updated_at)) <
        datetime(?)
    AND COALESCE(billing.stripe_status, '') NOT IN ${paidStatusList}`;

/**
 * Permanently remove audit history outside a free organization's window.
 * Organizations whose paid plan ended after `paidEndedAfter` are still in
 * their grace period and keep all history. Each batch records, per
 * organization, one `organization.audit_runs_purged` event by the job with
 * the number of runs removed, in the transaction that removes them.
 */
export async function purgeExpiredFreeAuditRuns(
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

async function purgeRetentionBatch(
  database: D1Database,
  runId: string,
  retainedAfter: string,
  paidEndedAfter: string,
) {
  const candidates = await database
    .prepare(
      `${expiredAudits}
       ORDER BY COALESCE(audit.completed_at, audit.updated_at) ASC, audit.id ASC
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
      maintenanceActor("purgeExpiredFreeAuditRuns", runId),
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
                     'audit_run' AS subject_type, MIN(expired.id) AS subject_id,
                     'organization.audit_runs_purged' AS action,
                     json_object('count', COUNT(*), 'completedBefore', ?,
                                 'retentionDays', ?) AS details
              FROM (${expiredAudits}) AS expired
              JOIN organization ON organization.id = expired.organization_id
              WHERE expired.id IN (SELECT value FROM json_each(?))
              GROUP BY organization.id`,
      },
    ),
    database
      .prepare(
        `DELETE FROM audits
         WHERE id IN (SELECT value FROM json_each(?))
           AND id IN (SELECT id FROM (${expiredAudits}))
         RETURNING id`,
      )
      .bind(ids, paidEndedAfter, retainedAfter),
  ]);
  return result?.results.length ?? 0;
}
