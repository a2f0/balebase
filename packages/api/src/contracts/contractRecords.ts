import { productName } from "@balebase/ui/brand";
import type {
  ContractStatus,
  FieldType,
  RecipientStatus,
  SigningOrder,
} from "@balebase/validators/contracts";
import type { ApiKeyPrincipal } from "../auth/apiEnv";
import { rowActivityStatement } from "../shared/activity";
import {
  contractSigningActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";
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
  api_key_channel: ApiKeyPrincipal["channel"] | null;
  api_key_name: string | null;
  created_at: string;
  detail: string | null;
  id: string;
  ip: string | null;
  recipient_id: string | null;
  type: string;
  user_agent: string | null;
}

export interface ContractEvent {
  actorUserId?: string | null;
  /** The key a person acted through, if any; its name is kept as a snapshot. */
  apiKey?: ApiKeyPrincipal | undefined;
  contractId: string;
  detail?: string | null;
  /** A stable ID lets a retried insert recognize one that already landed. */
  id?: string;
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
              event.api_key_name, event.api_key_channel,
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
  const apiKey = event.actorUserId ? event.apiKey : undefined;
  const values = [
    event.id ?? crypto.randomUUID(),
    event.contractId,
    event.recipientId ?? null,
    event.actorUserId ?? null,
    event.type,
    event.detail?.slice(0, 500) ?? null,
    event.ip ?? null,
    event.userAgent?.slice(0, 300) ?? null,
    new Date().toISOString(),
    apiKey?.id ?? null,
    apiKey?.id ?? null,
    apiKey?.channel ?? null,
  ];
  const columns = `INSERT INTO contract_events
         (id, contract_id, recipient_id, actor_user_id, type, detail, ip,
          user_agent, created_at, api_key_id, api_key_name, api_key_channel)`;
  const keyName = "(SELECT name FROM organization_api_keys WHERE id = ?)";
  return when
    ? database
        .prepare(
          `${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${keyName}, ?
           WHERE ${when.sql}`,
        )
        .bind(...values, ...when.bindings)
    : database
        .prepare(
          `${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${keyName}, ?)`,
        )
        .bind(...values);
}

/**
 * Shared activity about a contract, snapshotting the row inside the batch.
 * Signer emails, IPs, and signatures stay in the contract's own events.
 */
export function contractActivityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    contractId: string;
    details: { bindings: (string | number | null)[]; sql: string };
    organizationId: string;
  },
  condition?: { bindings: (string | number | null)[]; sql: string },
) {
  return rowActivityStatement(
    database,
    {
      action: input.action,
      actorId: input.actorId,
      details: input.details,
      id: input.contractId,
      label: "contracts.title",
      occurredAt: new Date().toISOString(),
      organizationId: input.organizationId,
      rootType: "contract",
      table: "contracts",
    },
    condition,
  );
}

/**
 * Shared activity no person recorded about a contract: a signer's decline or
 * the contract's completion, by the signing workflow and caused by the
 * contract's own event, snapshotting the row inside the batch. Records
 * nothing unless the contract matches `condition`.
 */
export function contractSigningActivityStatement(
  database: D1Database,
  input: {
    action: string;
    contractEventId: string;
    contractId: string;
    details: { bindings: (string | number | null)[]; sql: string };
  },
  condition: { bindings: (string | number | null)[]; sql: string },
) {
  return systemActivityRowsStatement(
    database,
    contractSigningActor(input.contractEventId),
    new Date().toISOString(),
    {
      bindings: [
        input.action,
        ...input.details.bindings,
        input.contractId,
        ...condition.bindings,
      ],
      sql: `SELECT organization_id, 'contract' AS root_type, id AS root_id,
                   title AS root_label, 'contract' AS subject_type,
                   id AS subject_id, ? AS action, ${input.details.sql} AS details
            FROM contracts WHERE id = ? AND (${condition.sql})`,
    },
  );
}

/** Holds once the contract exists, for events about a new one. */
export function contractExists(id: string) {
  return {
    bindings: [id],
    sql: "EXISTS (SELECT 1 FROM contracts WHERE id = ?)",
  };
}

/** Shared activity for a new contract, uploaded or made from a template. */
export function contractCreatedActivity(
  database: D1Database,
  actorId: string,
  contractId: string,
  organizationId: string,
) {
  return contractActivityStatement(database, {
    action: "contract.created",
    actorId,
    contractId,
    details: {
      bindings: [],
      sql: `json_object('documentSha256', document_sha256,
        'templateName', template_name, 'templateVersion', template_version)`,
    },
    organizationId,
  });
}

/** How many signers a contract has, for activity details. */
export const contractSignerCount = `(SELECT COUNT(*) FROM contract_recipients
  WHERE contract_recipients.contract_id = contracts.id)`;

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
