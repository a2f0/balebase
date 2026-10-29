import type {
  ActivityEvent,
  ActivityResourceType,
} from "@balebase/validators/activity";
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
  actor_user_id: string;
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
      "root_type NOT IN ('finance_transaction', 'finance_connection')",
    );
  if (resourceType) {
    filters.push("root_type = ?");
    bindings.push(resourceType);
  }
  if (root) {
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
