import { productName } from "@balebase/ui/brand";
import type {
  ActivityActorType,
  ActivityEvent,
  ActivityResourceType,
} from "@balebase/validators/activity";
import {
  type ActivityProvider,
  activityProviderNames,
} from "@balebase/validators/rules";
import type { Context } from "hono";
import type { ApiEnv, ApiKeyChannel, ApiKeyPrincipal } from "../auth/apiEnv";
import { cursorPage } from "./cursorPagination";

export interface ActivityRow {
  action: string;
  actor_api_key_channel: ApiKeyChannel | null;
  actor_api_key_id: string | null;
  actor_api_key_name: string | null;
  actor_email: string;
  actor_name: string;
  actor_source: string | null;
  actor_type: ActivityActorType;
  actor_user_id: string | null;
  details: string;
  historical: number;
  id: number;
  occurred_at: string;
  root_id: string;
  root_label: string;
  root_type: string;
  subject_id: string;
  subject_type: string;
}

interface ActivityRoot {
  /**
   * Also include events whose subject is this record under another root, such
   * as an email's links, which are recorded on the record it was linked to.
   */
  includeSubject?: boolean;
  /**
   * Also include library file events that name this folder: uploads into it,
   * moves into or out of it, and deletions of files in it.
   */
  includeFolderFiles?: boolean;
  issueId?: string;
  publishedTemplateOnly?: boolean;
  id: string;
  type: string;
}

/** The person behind a write, and the API key they made it with, if any. */
export interface ActivityActor {
  apiKey?: ApiKeyPrincipal | undefined;
  userId: string;
}

const pageSize = 50;

/**
 * History only organization managers read: group grants and revocations,
 * invitations (invited addresses), members' two-factor requirements, billing,
 * the organization's deletion and restoration, and the forms and checks
 * requested of people (employee records).
 */
const managerOnlyActivity = `(root_type IN ('organization_group', 'organization_billing',
                             'organization_invitation', 'employee_requirement')
  OR action IN ('organization.member_two_factor_requirement_changed',
                'organization.deletion_requested', 'organization.restored'))`;

/**
 * An organization's activity, or global activity when the organization is
 * null. Roots must be authorized by the caller before requesting global
 * activity.
 */
export async function findActivity(
  database: D1Database,
  organizationId: string | null,
  cursor?: string,
  root?: ActivityRoot,
  includeFinance = false,
  resourceType?: ActivityResourceType,
  includeManagerOnly = false,
) {
  if (cursor !== undefined && !/^[1-9]\d{0,15}$/.test(cursor)) return null;
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && !Number.isSafeInteger(before)) return null;
  const filters = [
    organizationId === null ? "organization_id IS NULL" : "organization_id = ?",
  ];
  const bindings: (string | number)[] =
    organizationId === null ? [] : [organizationId];
  if (!includeFinance)
    filters.push(
      "root_type NOT IN ('finance_transaction', 'finance_connection', 'finance_category')",
    );
  if (!includeManagerOnly) filters.push(`NOT ${managerOnlyActivity}`);
  if (resourceType) {
    filters.push("root_type = ?");
    bindings.push(resourceType);
  }
  if (root?.includeSubject) {
    filters.push(
      "((root_type = ? AND root_id = ?) OR (subject_type = ? AND subject_id = ?))",
    );
    bindings.push(root.type, root.id, root.type, root.id);
  } else if (root?.includeFolderFiles) {
    filters.push(
      `((root_type = ? AND root_id = ?) OR (root_type = 'library_file'
        AND ? IN (json_extract(details, '$.folderId'),
                  json_extract(details, '$.fromFolderId'),
                  json_extract(details, '$.toFolderId'))))`,
    );
    bindings.push(root.type, root.id, root.id);
  } else if (root) {
    filters.push("root_type = ? AND root_id = ?");
    bindings.push(root.type, root.id);
    if (root.issueId) {
      filters.push(
        "((subject_type IN ('issue', 'audit_issue') AND subject_id = ?) OR (subject_type = 'audit_issue_image' AND json_extract(details, '$.issueId') = ?))",
      );
      bindings.push(root.issueId, root.issueId);
    }
  }
  if (before !== null) {
    filters.push("id < ?");
    bindings.push(before);
  }
  if (root?.publishedTemplateOnly) {
    filters.push(`EXISTS (
      SELECT 1 FROM audit_template_versions AS version
      WHERE version.template_id = activity_events.root_id
        AND version.version = json_extract(activity_events.details, '$.version')
        AND version.status = 'published'
    )`);
  }
  const rows = await database
    .prepare(
      `SELECT * FROM activity_events
       WHERE ${filters.join(" AND ")}
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(...bindings, pageSize + 1)
    .all<ActivityRow>();
  const page = cursorPage(rows.results, pageSize, (row) => String(row.id));
  return {
    events: page.items.map(toActivity),
    nextCursor: page.nextCursor,
  };
}

export function auditAnswerActivityStatement(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  return database
    .prepare(
      `SELECT * FROM (
         SELECT activity_events.*,
                ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY id DESC) AS latest
         FROM activity_events
         WHERE organization_id = ? AND root_type = 'audit_run' AND root_id = ?
           AND action = 'audit.answer_changed'
       ) WHERE latest = 1`,
    )
    .bind(organizationId, auditId);
}

export function toAuditAnswerActivity(rows: ActivityRow[]) {
  return Object.fromEntries(
    rows.map((row) => [
      row.subject_id,
      { actor: activityActor(row), occurredAt: row.occurred_at },
    ]),
  );
}

export function requestActor(context: Context<ApiEnv>): ActivityActor {
  return {
    apiKey: context.get("apiKey"),
    userId: context.get("authSession").user.id,
  };
}

/**
 * Runs statements as one transaction. When an API key made the request, the
 * activity they record, by trigger or directly, is attributed to that key as
 * well as to its creator. Results line up with the given statements.
 */
export async function activityBatch(
  database: D1Database,
  apiKey: ApiKeyPrincipal | undefined,
  statements: D1PreparedStatement[],
) {
  if (!apiKey) return database.batch(statements);
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO activity_api_key_context (slot, api_key_id, channel)
         VALUES (1, ?, ?)`,
      )
      .bind(apiKey.id, apiKey.channel),
    ...statements,
    database.prepare("DELETE FROM activity_api_key_context"),
  ]);
  return results.slice(1, -1);
}

/**
 * The head of an `INSERT ... SELECT` that snapshots an event from the stored
 * rows it describes. Select the columns in this order, joining the actor as
 * `user AS actor`.
 */
export const insertActivity = `INSERT INTO activity_events (
  organization_id, root_type, root_id, root_label, subject_type, subject_id,
  action, actor_user_id, actor_name, actor_email, occurred_at, details
)`;

/** Include this statement in the same batch as the corresponding mutation. */
export function activityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    details: Record<string, unknown>;
    occurredAt: string;
    organizationId: string | null;
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  },
  condition: { bindings: (string | number | null)[]; sql: string },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type, subject_id,
         action, actor_user_id, actor_name, actor_email, occurred_at, details
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, actor.id, actor.name, actor.email, ?, ?
       FROM user AS actor WHERE actor.id = ? AND (${condition.sql})`,
    )
    .bind(
      input.organizationId,
      input.root.type,
      input.root.id,
      input.root.label,
      input.subject.type,
      input.subject.id,
      input.action,
      input.occurredAt,
      JSON.stringify(input.details),
      input.actorId,
      ...condition.bindings,
    );
}

/**
 * An event about one organization-owned row of `table`, read inside the
 * batch: the label and details are SQL over that row (unqualified columns are
 * the row's), so they snapshot it as this transaction sees it, including a row
 * a later statement in the batch updates or deletes. Records nothing unless
 * the row exists and matches `condition`.
 */
export function rowActivityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    details: { bindings: (string | number | null)[]; sql: string };
    id: string;
    label: string;
    occurredAt: string;
    organizationId: string;
    rootType: string;
    table: string;
  },
  condition: { bindings: (string | number | null)[]; sql: string } = {
    bindings: [],
    sql: "1 = 1",
  },
) {
  const { table } = input;
  return database
    .prepare(
      `WITH activity_actor AS (
         SELECT id AS acting_id, name AS acting_name, email AS acting_email
         FROM user WHERE id = ?
       )
       INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT ${table}.organization_id, ?, ${table}.id, ${input.label}, ?,
              ${table}.id, ?, acting_id, acting_name, acting_email, ?,
              ${input.details.sql}
       FROM ${table}, activity_actor
       WHERE ${table}.id = ? AND ${table}.organization_id = ?
         AND (${condition.sql})`,
    )
    .bind(
      input.actorId,
      input.rootType,
      input.rootType,
      input.action,
      input.occurredAt,
      ...input.details.bindings,
      input.id,
      input.organizationId,
      ...condition.bindings,
    );
}

/**
 * A change no person made: Balebase's maintenance (`system`, with the job's
 * ID as its source) or a provider (`provider`, such as Stripe). `causation`
 * names what caused it, such as the job run or the provider's event ID: it is
 * the deduplication boundary, so a redelivery records one event per cause,
 * action, root, and subject. Never use one for work a person asked for.
 */
export type SystemActor =
  | { causation: ActivityCausation; jobId: string; type: "system" }
  | {
      causation: ActivityCausation | null;
      provider: ActivityProvider;
      type: "provider";
    };

interface ActivityCausation {
  id: string;
  /** Such as `job_run`, `stripe_event`, or `plaid_webhook`. */
  type: string;
}

/** The system actor of one maintenance job run. */
export function maintenanceActor(jobId: string, runId: string): SystemActor {
  return { causation: { id: runId, type: "job_run" }, jobId, type: "system" };
}

/**
 * The system source of what a signing link did: Balebase's signing workflow
 * records a signer's decline and a contract's completion, caused by the
 * contract's own event, which names the signer.
 */
export const contractSigningSource = "contractSigning";

/** The signing workflow, as the actor of one contract event's outcome. */
export function contractSigningActor(contractEventId: string): SystemActor {
  return {
    causation: { id: contractEventId, type: "contract_event" },
    jobId: contractSigningSource,
    type: "system",
  };
}

/** The label stored with a system or provider event. */
function systemActorName(actor: SystemActor) {
  if (actor.type === "provider") return activityProviderNames[actor.provider];
  return actor.jobId === contractSigningSource
    ? `${productName} signing`
    : `${productName} maintenance`;
}

function systemActorBindings(actor: SystemActor) {
  return [
    actor.type,
    actor.type === "system" ? actor.jobId : actor.provider,
    systemActorName(actor),
    actor.causation?.type ?? null,
    actor.causation?.id ?? null,
  ];
}

/**
 * Records system or provider events, one per row of `events`, a SELECT that
 * returns `organization_id`, `root_type`, `root_id`, `root_label`,
 * `subject_type`, `subject_id`, `action`, and `details` (JSON text). Put it in
 * the same batch as the change, guarded by the same condition, so an event
 * exists only when the change commits. A cause already recorded for the same
 * action, root, and subject records nothing.
 */
export function systemActivityRowsStatement(
  database: D1Database,
  actor: SystemActor,
  occurredAt: string,
  events: { bindings: (string | number | null)[]; sql: string },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_type, actor_source, actor_name, actor_email,
         causation_type, causation_id, occurred_at, details
       )
       SELECT event.organization_id, event.root_type, event.root_id,
              event.root_label, event.subject_type, event.subject_id,
              event.action, ?, ?, ?, '', ?, ?, ?, event.details
       FROM (${events.sql}) AS event
       WHERE true
       ON CONFLICT DO NOTHING`,
    )
    .bind(...systemActorBindings(actor), occurredAt, ...events.bindings);
}

/**
 * `activityStatement` for a system or provider actor: one event, recorded
 * only when `condition` holds, in the same batch as the change.
 */
export function systemActivityStatement(
  database: D1Database,
  actor: SystemActor,
  input: {
    action: string;
    details: Record<string, unknown>;
    occurredAt: string;
    organizationId: string | null;
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  },
  condition: { bindings: (string | number | null)[]; sql: string } = {
    bindings: [],
    sql: "1 = 1",
  },
) {
  return systemActivityRowsStatement(database, actor, input.occurredAt, {
    bindings: [
      input.organizationId,
      input.root.type,
      input.root.id,
      input.root.label,
      input.subject.type,
      input.subject.id,
      input.action,
      JSON.stringify(input.details),
      ...condition.bindings,
    ],
    sql: `SELECT ? AS organization_id, ? AS root_type, ? AS root_id,
                 ? AS root_label, ? AS subject_type, ? AS subject_id,
                 ? AS action, ? AS details
          WHERE ${condition.sql}`,
  });
}

/**
 * Platform history that belongs to no organization and outlives what it
 * describes, such as purged accounts and organizations. Only root admins may
 * read it.
 */
export async function findPlatformActivity(
  database: D1Database,
  actions: readonly string[],
  cursor?: string,
) {
  if (cursor !== undefined && !/^[1-9]\d{0,15}$/.test(cursor)) return null;
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && !Number.isSafeInteger(before)) return null;
  const rows = await database
    .prepare(
      `SELECT * FROM activity_events
       WHERE organization_id IS NULL
         AND action IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR id < ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(JSON.stringify(actions), before, before, pageSize + 1)
    .all<ActivityRow>();
  const page = cursorPage(rows.results, pageSize, (row) => String(row.id));
  return { events: page.items.map(toActivity), nextCursor: page.nextCursor };
}

function activityActor(row: ActivityRow) {
  return {
    // Migration 0061 added the key's name and channel together.
    apiKey:
      row.actor_api_key_name === null || row.actor_api_key_channel === null
        ? null
        : {
            channel: row.actor_api_key_channel,
            id: row.actor_api_key_id,
            name: row.actor_api_key_name,
          },
    email: row.actor_email,
    id: row.actor_user_id,
    name: row.actor_name,
    source: row.actor_source,
    type: row.actor_type,
  };
}

function toActivity(row: ActivityRow): ActivityEvent {
  return {
    action: row.action,
    actor: activityActor(row),
    details: JSON.parse(row.details) as Record<string, unknown>,
    historical: Boolean(row.historical),
    id: row.id,
    occurredAt: row.occurred_at,
    root: { id: row.root_id, label: row.root_label, type: row.root_type },
    subject: { id: row.subject_id, type: row.subject_type },
  };
}
