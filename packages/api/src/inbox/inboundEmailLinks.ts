import {
  type InboundEmailLink,
  type InboundEmailLinkTarget,
  inboxRoutes,
  type LinkedEmail,
} from "@balebase/validators/inbox";
import type { Context } from "hono";
import type { ApiEnv } from "../auth/authMiddleware";
import { userHasCapability } from "../organizations/organizationGroups";
import { readBody, respond } from "../shared/respond";

type LinkContext = Context<ApiEnv>;

type EmailLinkTargetType = InboundEmailLinkTarget["targetType"];

interface EmailLinkRow {
  equipment_make: string | null;
  equipment_model: string | null;
  equipment_serial_number: string | null;
  equipment_type: string | null;
  folder_name: string | null;
  id: string;
  target_id: string;
  target_type: EmailLinkTargetType;
  transaction_amount: number | null;
  transaction_currency_code: string | null;
  transaction_date: string | null;
  transaction_merchant_name: string | null;
  transaction_name: string | null;
}

interface LinkedEmailRow {
  archived_at: string | null;
  attachment_count: number;
  envelope_from: string;
  id: string;
  link_id: string;
  received_at: string;
  subject: string | null;
  target_id: string;
}

/**
 * The records an email is linked to. Finance links are only visible to
 * members of a group with the Finance capability, and, like the Finance
 * listing, hide transactions that Plaid has since removed.
 */
export async function listEmailLinks(
  context: LinkContext,
  organizationId: string,
  emailId: string,
) {
  const rows = await emailLinkRows(context.env.DB, organizationId, emailId);
  const financeVisible =
    rows.some(({ target_type }) => target_type === "finance_transaction") &&
    (await canUseFinance(context));
  return rows
    .filter(
      (row) => financeVisible || row.target_type !== "finance_transaction",
    )
    .flatMap((row) => toEmailLink(row) ?? []);
}

/** Links an email outside Trash to a library folder, equipment, or a transaction. */
export async function createEmailLink(context: LinkContext) {
  const emailId = context.req.param("id") ?? "";
  const input = await readBody(
    context,
    inboxRoutes.link,
    "A link target type and id are required.",
  );
  if (input instanceof Response) return input;
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const email = await database
    .prepare(
      `SELECT id FROM inbound_emails
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(emailId, organizationId)
    .first<{ id: string }>();
  if (!email) return context.json({ error: "Email not found." }, 404);
  if (
    input.targetType === "finance_transaction" &&
    !(await canUseFinance(context))
  ) {
    return financeRequired(context);
  }
  // The target is checked in the insert itself: a target deleted a moment
  // earlier (after its cleanup trigger ran) must not gain an orphaned link.
  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO inbound_email_links
         (id, organization_id, email_id, target_type, target_id, created_by,
          created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (${targetQueries[input.targetType]})
         AND EXISTS (SELECT 1 FROM inbound_emails
                     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL)
       ON CONFLICT (email_id, target_type, target_id) DO NOTHING`,
    )
    .bind(
      id,
      organizationId,
      email.id,
      input.targetType,
      input.targetId,
      context.get("authSession").user.id,
      new Date().toISOString(),
      input.targetId,
      organizationId,
      email.id,
      organizationId,
    )
    .run();
  const row = (await emailLinkRows(database, organizationId, email.id)).find(
    (link) =>
      link.target_type === input.targetType &&
      link.target_id === input.targetId,
  );
  const link = row && toEmailLink(row);
  if (!link) return context.json({ error: "Link target not found." }, 404);
  return respond(
    context,
    inboxRoutes.link,
    { link },
    link.id === id ? 201 : 200,
  );
}

export async function deleteEmailLink(context: LinkContext) {
  const organizationId = context.get("organizationId");
  const link = await context.env.DB.prepare(
    `SELECT id, target_type FROM inbound_email_links
     WHERE id = ? AND email_id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("linkId"), context.req.param("id"), organizationId)
    .first<{ id: string; target_type: EmailLinkTargetType }>();
  if (!link) return context.json({ error: "Link not found." }, 404);
  if (
    link.target_type === "finance_transaction" &&
    !(await canUseFinance(context))
  ) {
    return financeRequired(context);
  }
  await context.env.DB.prepare(
    `DELETE FROM inbound_email_links WHERE id = ? AND organization_id = ?`,
  )
    .bind(link.id, organizationId)
    .run();
  return context.body(null, 204);
}

/**
 * Emails outside Trash that are linked to records of one type, newest first.
 * Pass a target id to limit the result to a single record.
 */
export async function listLinkedEmails(
  database: D1Database,
  organizationId: string,
  targetType: EmailLinkTargetType,
  targetId?: string,
) {
  const values = targetId
    ? [organizationId, targetType, targetId]
    : [organizationId, targetType];
  const result = await database
    .prepare(
      `SELECT link.id AS link_id, link.target_id, email.id, email.subject,
              email.envelope_from, email.received_at, email.archived_at,
              (SELECT COUNT(*) FROM inbound_email_attachments AS attachment
               WHERE attachment.email_id = email.id) AS attachment_count
       FROM inbound_email_links AS link
       JOIN inbound_emails AS email
         ON email.id = link.email_id
        AND email.organization_id = link.organization_id
       WHERE link.organization_id = ? AND link.target_type = ?
         ${targetId ? "AND link.target_id = ?" : ""}
         AND email.deleted_at IS NULL
       ORDER BY email.received_at DESC, email.id DESC`,
    )
    .bind(...values)
    .all<LinkedEmailRow>();
  return result.results;
}

export function toLinkedEmail(row: LinkedEmailRow): LinkedEmail {
  return {
    attachmentCount: row.attachment_count,
    from: row.envelope_from,
    id: row.id,
    linkId: row.link_id,
    receivedAt: row.received_at,
    status: row.archived_at ? "archived" : "inbox",
    subject: row.subject,
  };
}

async function emailLinkRows(
  database: D1Database,
  organizationId: string,
  emailId: string,
) {
  const result = await database
    .prepare(
      `SELECT link.id, link.target_type, link.target_id,
              folder.name AS folder_name,
              item.type AS equipment_type, item.make AS equipment_make,
              item.model AS equipment_model,
              item.serial_number AS equipment_serial_number,
              txn.name AS transaction_name,
              txn.merchant_name AS transaction_merchant_name,
              txn.amount AS transaction_amount,
              txn.currency_code AS transaction_currency_code,
              txn.transaction_date AS transaction_date
       FROM inbound_email_links AS link
       LEFT JOIN library_folders AS folder
         ON link.target_type = 'library_folder'
        AND folder.id = link.target_id
        AND folder.organization_id = link.organization_id
       LEFT JOIN equipment AS item
         ON link.target_type = 'equipment'
        AND item.id = link.target_id
        AND item.organization_id = link.organization_id
       LEFT JOIN plaid_transactions AS txn
         ON link.target_type = 'finance_transaction'
        AND txn.id = link.target_id
        AND txn.organization_id = link.organization_id
        AND txn.source_status = 'active'
       WHERE link.email_id = ? AND link.organization_id = ?
       ORDER BY link.created_at ASC, link.rowid ASC`,
    )
    .bind(emailId, organizationId)
    .all<EmailLinkRow>();
  return result.results;
}

/** Each target type's existence check, bound to (target id, organization). */
const targetQueries: Record<EmailLinkTargetType, string> = {
  equipment: `SELECT 1 FROM equipment WHERE id = ? AND organization_id = ?`,
  finance_transaction: `SELECT 1 FROM plaid_transactions
    WHERE id = ? AND organization_id = ? AND source_status = 'active'`,
  library_folder: `SELECT 1 FROM library_folders
    WHERE id = ? AND organization_id = ?`,
};

function canUseFinance(context: LinkContext) {
  return userHasCapability(
    context.env.DB,
    context.get("organizationId"),
    context.get("authSession").user.id,
    "finance",
  );
}

function toEmailLink(row: EmailLinkRow): InboundEmailLink | null {
  if (row.target_type === "equipment") {
    if (row.equipment_make === null) return null;
    return {
      equipment: {
        make: row.equipment_make,
        model: row.equipment_model ?? "",
        serialNumber: row.equipment_serial_number,
        type: row.equipment_type ?? "",
      },
      id: row.id,
      targetId: row.target_id,
      targetType: row.target_type,
    };
  }
  if (row.target_type === "library_folder") {
    if (row.folder_name === null) return null;
    return {
      folder: { name: row.folder_name },
      id: row.id,
      targetId: row.target_id,
      targetType: row.target_type,
    };
  }
  if (row.transaction_name === null) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    targetType: row.target_type,
    transaction: {
      amount: row.transaction_amount ?? 0,
      currencyCode: row.transaction_currency_code,
      date: row.transaction_date ?? "",
      merchantName: row.transaction_merchant_name,
      name: row.transaction_name,
    },
  };
}

function financeRequired(context: LinkContext) {
  return context.json({ error: "Finance group membership required." }, 403);
}
