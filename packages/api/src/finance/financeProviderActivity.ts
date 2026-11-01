import {
  type ActivityCausation,
  providerActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";
import type { SyncJobRow } from "./financeSyncJobs";

/**
 * Bank connection changes Plaid reports through a sync job, recorded on the
 * connection (`finance_connection`, Finance capability to read) with Plaid as
 * the actor, never the person who asked for the sync.
 */

const connectionLabel = "COALESCE(item.institution_name, 'Bank connection')";

/** The cause of one page of a sync job: a replayed page records nothing new. */
export function syncPageCausation(job: SyncJobRow): ActivityCausation {
  return {
    id: `${job.id}:${job.restarts}:${job.pages}`,
    type: "plaid_sync_page",
  };
}

/**
 * Records `finance.connection_status_changed` when the job's result moves
 * the connection to another status or error code: a failed login or
 * exhausted retries (`error`), or a recovery (`active`). Plaid's message is
 * left out. Put it before the job's checkpoint, as it requires the job's
 * lease that the checkpoint ends; the connection update follows that.
 */
export function connectionStatusStatement(
  database: D1Database,
  job: SyncJobRow,
  after: { errorCode: string | null; status: "active" | "error" },
) {
  return systemActivityRowsStatement(
    database,
    providerActor("plaid", { id: job.id, type: "job_run" }),
    new Date().toISOString(),
    {
      bindings: [
        after.status,
        after.errorCode,
        job.connection_id,
        job.organization_id,
        after.status,
        after.errorCode,
        job.id,
        job.lease_until,
      ],
      sql: `SELECT item.organization_id, 'finance_connection' AS root_type,
                   item.id AS root_id, ${connectionLabel} AS root_label,
                   'finance_connection' AS subject_type, item.id AS subject_id,
                   'finance.connection_status_changed' AS action,
                   json_object(
                     'before', json_object('status', item.status,
                                           'errorCode', item.error_code),
                     'after', json_object('status', ?, 'errorCode', ?)
                   ) AS details
            FROM plaid_items AS item
            WHERE item.id = ? AND item.organization_id = ?
              AND item.status IN ('active', 'error')
              AND (item.status IS NOT ? OR item.error_code IS NOT ?)
              AND EXISTS (
                SELECT 1 FROM job_runs
                WHERE id = ? AND status = 'running' AND lease_until = ?
              )`,
    },
  );
}

/**
 * Records `finance.transactions_removed` when Plaid withdraws transactions
 * that were still shown, with how many and their IDs. Put it before the
 * update that marks them removed.
 */
export function removedTransactionsStatement(
  database: D1Database,
  causation: ActivityCausation,
  organizationId: string,
  itemId: string,
  plaidTransactionIds: string[],
) {
  return systemActivityRowsStatement(
    database,
    providerActor("plaid", causation),
    new Date().toISOString(),
    {
      bindings: [JSON.stringify(plaidTransactionIds), itemId, organizationId],
      sql: `SELECT item.organization_id, 'finance_connection' AS root_type,
                   item.id AS root_id, ${connectionLabel} AS root_label,
                   'finance_connection' AS subject_type, item.id AS subject_id,
                   'finance.transactions_removed' AS action,
                   json_object('count', COUNT(txn.id),
                               'transactionIds', json_group_array(txn.id)
                   ) AS details
            FROM plaid_items AS item
            JOIN plaid_transactions AS txn
              ON txn.plaid_item_record_id = item.id
             AND txn.source_status = 'active'
             AND txn.plaid_transaction_id IN (SELECT value FROM json_each(?))
            WHERE item.id = ? AND item.organization_id = ?
            GROUP BY item.id`,
    },
  );
}

/**
 * Records `finance.records_carried_over` on the connection for each
 * disconnected connection whose accounts and transactions it takes over
 * (they keep their annotations, categories, and issues), with how many.
 * The subject is the connection they came from. Put it before the writes
 * that move them.
 */
export function carriedOverStatement(
  database: D1Database,
  causation: ActivityCausation,
  organizationId: string,
  itemId: string,
  carried: { accountIds: string[]; transactionIds: string[] },
) {
  return systemActivityRowsStatement(
    database,
    providerActor("plaid", causation),
    new Date().toISOString(),
    {
      bindings: [
        JSON.stringify(carried.accountIds),
        JSON.stringify(carried.transactionIds),
        itemId,
        organizationId,
      ],
      sql: `WITH carried_account AS (
              SELECT id, plaid_item_record_id FROM plaid_accounts
              WHERE id IN (SELECT value FROM json_each(?))
            ),
            carried_transaction AS (
              SELECT id, plaid_item_record_id FROM plaid_transactions
              WHERE id IN (SELECT value FROM json_each(?))
            )
            SELECT item.organization_id, 'finance_connection' AS root_type,
                   item.id AS root_id, ${connectionLabel} AS root_label,
                   'finance_connection' AS subject_type,
                   archived.id AS subject_id,
                   'finance.records_carried_over' AS action,
                   json_object(
                     'fromConnectionId', archived.id,
                     'fromInstitutionName', archived.institution_name,
                     'accountCount', (SELECT COUNT(*) FROM carried_account
                       WHERE plaid_item_record_id = archived.id),
                     'transactionCount', (SELECT COUNT(*) FROM carried_transaction
                       WHERE plaid_item_record_id = archived.id)
                   ) AS details
            FROM plaid_items AS item
            JOIN plaid_items AS archived
              ON archived.organization_id = item.organization_id
             AND archived.status = 'disconnected'
            WHERE item.id = ? AND item.organization_id = ?
              AND archived.id IN (
                SELECT plaid_item_record_id FROM carried_account
                UNION SELECT plaid_item_record_id FROM carried_transaction
              )`,
    },
  );
}
