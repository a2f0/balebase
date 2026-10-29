import { productName } from "@balebase/ui/brand";
import type {
  ContractStatus,
  FieldType,
  RecipientStatus,
  SigningOrder,
} from "@balebase/validators/contracts";
import type { ContractMail } from "./contractMail";

export interface ContractRow {
  completed_at: string | null;
  created_at: string;
  created_by: string | null;
  document_filename: string;
  document_object_key: string;
  document_page_count: number;
  document_sha256: string;
  document_size: number;
  due_date: string | null;
  final_object_key: string | null;
  final_sha256: string | null;
  id: string;
  message: string;
  organization_id: string;
  reminder_interval_days: number | null;
  revision: number;
  sent_at: string | null;
  sent_by: string | null;
  signing_order: SigningOrder;
  status: ContractStatus;
  template_name: string | null;
  template_version: number | null;
  title: string;
  updated_at: string;
  void_reason: string | null;
  voided_at: string | null;
}

export interface RecipientRow {
  contract_id: string;
  created_at: string;
  decline_reason: string | null;
  declined_at: string | null;
  email: string;
  id: string;
  initials_image: string | null;
  last_reminded_at: string | null;
  name: string;
  notified_at: string | null;
  routing_order: number;
  signature_image: string | null;
  signed_at: string | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
  status: RecipientStatus;
  token_hash: string | null;
  token_nonce: string | null;
  viewed_at: string | null;
}

export interface FieldRow {
  contract_id: string;
  height: number;
  id: string;
  label: string | null;
  page: number;
  recipient_id: string;
  required: number;
  type: FieldType;
  value: string | null;
  width: number;
  x: number;
  y: number;
}

export interface EventRow {
  actor_name: string | null;
  actor_user_id: string | null;
  created_at: string;
  detail: string | null;
  id: string;
  ip: string | null;
  recipient_id: string | null;
  type: string;
  user_agent: string | null;
}

interface ContractEvent {
  actorUserId?: string | null;
  contractId: string;
  detail?: string | null;
  ip?: string | null;
  recipientId?: string | null;
  type: string;
  userAgent?: string | null;
}

const contractColumns = `id, organization_id, title, message, status, signing_order,
  due_date, reminder_interval_days, document_object_key, document_filename,
  document_size, document_sha256, document_page_count, final_object_key,
  final_sha256, created_by, sent_by, created_at, updated_at, sent_at,
  completed_at, voided_at, void_reason, revision, template_name, template_version`;

export function findContract(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT ${contractColumns} FROM contracts
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<ContractRow>();
}

export function findContractById(database: D1Database, id: string) {
  return database
    .prepare(`SELECT ${contractColumns} FROM contracts WHERE id = ?`)
    .bind(id)
    .first<ContractRow>();
}

export async function listRecipients(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT id, contract_id, name, email, routing_order, status, token_nonce,
              token_hash, notified_at, last_reminded_at, viewed_at, signed_at, signed_ip,
              signed_user_agent, signature_image, initials_image, declined_at,
              decline_reason, created_at
       FROM contract_recipients WHERE contract_id = ?
       ORDER BY routing_order ASC, created_at ASC, rowid ASC`,
    )
    .bind(contractId)
    .all<RecipientRow>();
  return result.results;
}

export async function listFields(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT id, contract_id, recipient_id, type, page, x, y, width, height,
              required, label, value
       FROM contract_fields WHERE contract_id = ?
       ORDER BY page ASC, y ASC, x ASC`,
    )
    .bind(contractId)
    .all<FieldRow>();
  return result.results;
}

export async function listEvents(database: D1Database, contractId: string) {
  const result = await database
    .prepare(
      `SELECT event.id, event.recipient_id, event.actor_user_id, event.type,
              event.detail, event.ip, event.user_agent, event.created_at,
              actor.name AS actor_name
       FROM contract_events AS event
       LEFT JOIN user AS actor ON actor.id = event.actor_user_id
       WHERE event.contract_id = ?
       ORDER BY event.created_at ASC, event.rowid ASC`,
    )
    .bind(contractId)
    .all<EventRow>();
  return result.results;
}

/**
 * Inserts an audit event; with `when`, only if that SQL condition holds, so
 * it can share a batch with the change it records.
 */
export function eventStatement(
  database: D1Database,
  event: ContractEvent,
  when?: { bindings: unknown[]; sql: string },
) {
  const values = [
    crypto.randomUUID(),
    event.contractId,
    event.recipientId ?? null,
    event.actorUserId ?? null,
    event.type,
    event.detail?.slice(0, 500) ?? null,
    event.ip ?? null,
    event.userAgent?.slice(0, 300) ?? null,
    new Date().toISOString(),
  ];
  const columns = `INSERT INTO contract_events
         (id, contract_id, recipient_id, actor_user_id, type, detail, ip,
          user_agent, created_at)`;
  return when
    ? database
        .prepare(
          `${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${when.sql}`,
        )
        .bind(...values, ...when.bindings)
    : database
        .prepare(`${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(...values);
}

export async function recordEvent(database: D1Database, event: ContractEvent) {
  await eventStatement(database, event).run();
}

/** The organization and sender that emails about a contract come from. */
export async function mailFor(
  database: D1Database,
  contract: ContractRow,
): Promise<ContractMail> {
  const row = await database
    .prepare(
      `SELECT organization.name AS organization_name,
              sender.name AS sender_name, sender.email AS sender_email
       FROM organization
       LEFT JOIN user AS sender ON sender.id = ?
       WHERE organization.id = ?`,
    )
    .bind(contract.sent_by ?? contract.created_by, contract.organization_id)
    .first<{
      organization_name: string;
      sender_email: string | null;
      sender_name: string | null;
    }>();
  return {
    contractId: contract.id,
    dueDate: contract.due_date,
    message: contract.message,
    organizationName: row?.organization_name ?? productName,
    sender:
      row?.sender_email && row.sender_name
        ? { email: row.sender_email, name: row.sender_name }
        : null,
    title: contract.title,
  };
}
