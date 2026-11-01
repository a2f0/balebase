import {
  maintenanceActor,
  systemActivityRowsStatement,
} from "../shared/activity";
import type { Bindings } from "../types";
import { emailLabel } from "./inboundEmailLinks";

const batchSize = 100;
const trashRetentionDays = 30;

/** Trash email past its retention window; unqualified columns are the email's. */
const purgeableEmail = `inbound_emails.id IN (SELECT value FROM json_each(?))
  AND inbound_emails.deleted_at IS NOT NULL
  AND julianday(inbound_emails.deleted_at) <= julianday(?)`;

/**
 * Permanently deletes up to 100 emails that have been in Trash for at least
 * 30 days, replacing the old `emails:purge` operator script. One batch records
 * each email's purge on its history (`inbox.email_purged`) and each link it
 * still had as `inbox.email_unlinked` on the linked record, all by the job;
 * queues the raw message and attachments for the deleted-file cleanup, which
 * removes them only after this commits and retries on failure; and deletes
 * the emails. Eligibility is rechecked in every statement, so an email
 * restored first is kept and records nothing.
 */
export async function purgeTrashedEmails(
  environment: Pick<Bindings, "DB">,
  runId: string,
  now = new Date(),
) {
  const database = environment.DB;
  const cutoff = new Date(
    now.getTime() - trashRetentionDays * 86400000,
  ).toISOString();
  const candidates = await database
    .prepare(
      `SELECT id FROM inbound_emails
       WHERE deleted_at IS NOT NULL AND julianday(deleted_at) <= julianday(?)
       ORDER BY julianday(deleted_at), id
       LIMIT ?`,
    )
    .bind(cutoff, batchSize)
    .all<{ id: string }>();
  if (!candidates.results.length) return 0;
  const ids = JSON.stringify(candidates.results.map(({ id }) => id));
  const actor = maintenanceActor("purgeTrashedEmails", runId);
  const occurredAt = now.toISOString();
  const queuedAt = now.toISOString();
  const results = await database.batch<{ id: string }>([
    // Links are recorded on the linked record, so a transaction's stay
    // behind Finance access, as when a person unlinks an email.
    systemActivityRowsStatement(database, actor, occurredAt, {
      bindings: [ids, cutoff],
      sql: `SELECT link.organization_id, link.target_type AS root_type,
                   link.target_id AS root_id,
                   COALESCE(CASE link.target_type
                     WHEN 'library_folder' THEN folder.name
                     WHEN 'equipment' THEN item.make || ' ' || item.model
                     ELSE COALESCE(txn.merchant_name, txn.name)
                   END, '') AS root_label,
                   'inbound_email' AS subject_type,
                   inbound_emails.id AS subject_id,
                   'inbox.email_unlinked' AS action,
                   json_object('subject', ${emailLabel},
                               'from', inbound_emails.envelope_from,
                               'via', 'email_purged') AS details
            FROM inbound_email_links AS link
            JOIN inbound_emails ON inbound_emails.id = link.email_id
            LEFT JOIN library_folders AS folder
              ON link.target_type = 'library_folder' AND folder.id = link.target_id
            LEFT JOIN equipment AS item
              ON link.target_type = 'equipment' AND item.id = link.target_id
            LEFT JOIN plaid_transactions AS txn
              ON link.target_type = 'finance_transaction' AND txn.id = link.target_id
            WHERE ${purgeableEmail}`,
    }),
    // Every member reads the email's history, so it counts only folder and
    // equipment links; transaction links are on the transactions.
    systemActivityRowsStatement(database, actor, occurredAt, {
      bindings: [ids, cutoff],
      sql: `SELECT inbound_emails.organization_id,
                   'inbound_email' AS root_type, inbound_emails.id AS root_id,
                   ${emailLabel} AS root_label, 'inbound_email' AS subject_type,
                   inbound_emails.id AS subject_id,
                   'inbox.email_purged' AS action,
                   json_object(
                     'deletedAt', inbound_emails.deleted_at,
                     'attachmentCount', (
                       SELECT COUNT(*) FROM inbound_email_attachments AS attachment
                       WHERE attachment.email_id = inbound_emails.id),
                     'folderLinkCount', (
                       SELECT COUNT(*) FROM inbound_email_links AS link
                       WHERE link.email_id = inbound_emails.id
                         AND link.target_type = 'library_folder'),
                     'equipmentLinkCount', (
                       SELECT COUNT(*) FROM inbound_email_links AS link
                       WHERE link.email_id = inbound_emails.id
                         AND link.target_type = 'equipment')
                   ) AS details
            FROM inbound_emails WHERE ${purgeableEmail}`,
    }),
    database
      .prepare(
        `INSERT OR REPLACE INTO deleted_object_cleanup
           (id, organization_id, object_key, deleted_at, cleanup_token,
            cleanup_claimed_at)
         SELECT 'inbound-email:' || inbound_emails.id,
                inbound_emails.organization_id, inbound_emails.raw_object_key,
                ?, NULL, NULL
         FROM inbound_emails WHERE ${purgeableEmail}
         UNION ALL
         SELECT 'inbound-attachment:' || attachment.id,
                inbound_emails.organization_id, attachment.object_key,
                ?, NULL, NULL
         FROM inbound_email_attachments AS attachment
         JOIN inbound_emails ON inbound_emails.id = attachment.email_id
         WHERE ${purgeableEmail}`,
      )
      .bind(queuedAt, ids, cutoff, queuedAt, ids, cutoff),
    database
      .prepare(
        `DELETE FROM inbound_emails WHERE ${purgeableEmail} RETURNING id`,
      )
      .bind(ids, cutoff),
  ]);
  const purged = results.at(-1)?.results ?? [];
  for (const { id } of purged)
    console.log({ event: "inbound_email_purged", emailId: id });
  return purged.length;
}
