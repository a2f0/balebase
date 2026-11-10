import type { Person } from "@balebase/validators/fields";
import type {
  OfflineAuditState,
  OfflineOperation,
} from "@balebase/validators/offline";
import {
  type AnswerConflict,
  answerColumns,
  answerValues,
  mergeAnswers,
  type StoredAnswer,
  storedAnswers,
} from "../audits/auditAnswers";
import { allRequiredAnswered, parseResponses } from "../audits/auditDefinition";
import { type AuditRow, findAudit } from "../audits/auditRunRecords";
import { storedDefinition } from "../audits/auditTemplates";
import {
  type IssueContext,
  issueInsert,
  issueTargetAvailable,
} from "../issues/issueRecords";
import { activityStatement } from "../shared/activity";

interface SqlCondition {
  bindings: (string | number | null)[];
  sql: string;
}

/** An operation's writes, and how its receipt tells they applied. */
export interface OfflineWrites {
  statements: D1PreparedStatement[];
  /**
   * SQL that holds right after `statements` only if they applied; the
   * receipt that follows them is written on it.
   */
  applied: SqlCondition;
  /** Why the operation did not apply when its batch committed without it. */
  rejected: string;
  /**
   * Whether writes that did not apply are computed again: a merge that found
   * its audit moved on merges over the newer copy instead.
   */
  retry: boolean;
}

/** An issue insert skips an assignee who has left the organization. */
const formerAssigneeError =
  "The issue assignee is no longer a member. Your local work has been kept.";

const invalidAnswersError =
  "An answer is not valid for this form. Your local work has been kept.";

/** Why a merge did not apply after every retry: the audit kept changing. */
const auditMovedError =
  "This audit kept changing on the server while this device synced. It will try again.";

/** Each statement after a guarded write runs only if the one before it wrote. */
const afterWrite: SqlCondition = { sql: "changes() > 0", bindings: [] };

/** The writes that apply `operation`, or why it cannot apply. */
export function offlineWrites(
  context: IssueContext,
  operation: OfflineOperation,
): Promise<OfflineWrites | string> {
  switch (operation.type) {
    case "auditStart":
      return startWrites(context, operation);
    case "auditSave":
      return saveWrites(context, operation);
    case "issue":
      return issueWrites(context, operation);
  }
}

/**
 * Creates the audit in progress, then saves its answers, each with the time
 * the device gave it, in a second statement so the audit triggers record
 * them with the sync actor.
 */
async function startWrites(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "auditStart" }>,
): Promise<OfflineWrites | string> {
  const organizationId = context.get("organizationId");
  const template = await findSyncableVersion(
    context.env.DB,
    organizationId,
    operation.templateId,
    operation.templateVersion,
  );
  if (!template)
    return "The downloaded form version is no longer available. Your local work has been kept.";
  // A deleted project still takes the work done for it; only one that never
  // belonged to the organization is refused.
  const project = await context.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND organization_id = ?",
  )
    .bind(operation.projectId, organizationId)
    .first<{ id: string }>();
  if (!project)
    return "This audit's project is not in this organization. Your local work has been kept.";
  const userId = context.get("authSession").user.id;
  const answers = Object.fromEntries(
    Object.entries(operation.answers).map(([itemId, { at, value }]) => [
      itemId,
      { at, by: userId, value },
    ]),
  );
  if (
    !parseResponses(
      answerValues(answers),
      storedDefinition(template.definition),
    )
  )
    return invalidAnswersError;
  const columns = answerColumns(answers);
  const now = new Date().toISOString();
  return {
    statements: [
      context.env.DB.prepare(`INSERT INTO audits
        (id, organization_id, project_id, template_id, template_family_id,
         template_version_id, template_version, template_name, definition,
         responses, status, started_by, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?)`).bind(
        operation.id,
        organizationId,
        project.id,
        template.id,
        template.version_id,
        template.version,
        template.name,
        template.definition,
        userId,
        now,
        now,
      ),
      context.env.DB.prepare(`UPDATE audits SET responses = ?, answer_meta = ?,
        updated_at = ?, activity_actor_id = ?, revision = revision + 1
        WHERE id = ? AND organization_id = ?`).bind(
        columns.responses,
        columns.answerMeta,
        now,
        userId,
        operation.id,
        organizationId,
      ),
    ],
    applied: {
      sql: "EXISTS (SELECT 1 FROM audits WHERE id = ? AND organization_id = ?)",
      bindings: [operation.id, organizationId],
    },
    rejected: "This audit was not saved. Your local work has been kept.",
    retry: false,
  };
}

/**
 * Merges a device's answers into the audit, last writer wins by the time
 * each answer was given (`mergeAnswers`), and completes it when asked. Each
 * conflict the merge resolved is recorded with both answers. A completed
 * audit keeps its answers, so every differing answer is recorded as
 * discarded; a discarded audit takes nothing.
 *
 * The writes hold only over the revision the merge read: a write landing in
 * between leaves them unapplied, and the merge runs again over it.
 */
async function saveWrites(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "auditSave" }>,
): Promise<OfflineWrites | string> {
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    operation.auditId,
  );
  if (!audit)
    return "This audit is no longer on the server. Your local work has been kept.";
  if (audit.deleted_at)
    return "This audit was discarded on the server. Your local work has been kept.";
  const definition = storedDefinition(audit.definition);
  const given = Object.fromEntries(
    Object.entries(operation.answers).map(([itemId, { value }]) => [
      itemId,
      value,
    ]),
  );
  if (!parseResponses(given, definition)) return invalidAnswersError;
  const sealed = audit.status === "completed";
  const merged = mergeAnswers(
    storedAnswers(audit),
    operation.answers,
    userId,
    sealed,
  );
  const completion = sealed ? undefined : operation.completion;
  if (
    completion &&
    !allRequiredAnswered(definition, answerValues(merged.answers))
  )
    return "Complete every required item with a valid answer before syncing.";
  const now = new Date().toISOString();
  const conflicts = await conflictEvents(
    context,
    audit,
    merged.conflicts,
    sealed,
    now,
  );
  const unchanged: SqlCondition = {
    sql: `EXISTS (SELECT 1 FROM audits WHERE id = ? AND organization_id = ?
      AND revision = ? AND status = ? AND deleted_at IS NULL)`,
    bindings: [audit.id, organizationId, audit.revision, audit.status],
  };
  const common = { rejected: auditMovedError, retry: true };
  // Nothing to save: the answers it lost are its only record.
  if (!merged.changed && !completion)
    return { ...common, applied: unchanged, statements: conflicts(unchanged) };
  const columns = answerColumns(merged.answers);
  return {
    ...common,
    applied: afterWrite,
    statements: [
      context.env.DB.prepare(`UPDATE audits SET responses = ?, answer_meta = ?,
        status = ?, completed_at = ?, updated_at = ?, activity_actor_id = ?,
        revision = revision + 1
        WHERE id = ? AND organization_id = ? AND revision = ?
          AND status = 'in_progress' AND deleted_at IS NULL`).bind(
        columns.responses,
        columns.answerMeta,
        completion ? "completed" : "in_progress",
        completion ? now : null,
        now,
        userId,
        audit.id,
        organizationId,
        audit.revision,
      ),
      ...conflicts(afterWrite),
      ...(completion ? [offlineTiming(context, audit, completion, now)] : []),
    ],
  };
}

/** The device-reported start and completion times, after the save. */
function offlineTiming(
  context: IssueContext,
  audit: AuditRow,
  completion: { completedAt: string; startedAt: string },
  now: string,
) {
  return activityStatement(
    context.env.DB,
    {
      action: "audit.offline_synced",
      actorId: context.get("authSession").user.id,
      organizationId: context.get("organizationId"),
      occurredAt: now,
      root: { id: audit.id, type: "audit_run", label: audit.template_name },
      subject: { id: audit.id, type: "audit_run" },
      details: {
        clientStartedAt: completion.startedAt,
        clientCompletedAt: completion.completedAt,
      },
    },
    afterWrite,
  );
}

/** The server's copy of an audit as a device merges it, or null when gone. */
export async function readAuditState(
  database: D1Database,
  organizationId: string,
  auditId: string,
): Promise<OfflineAuditState | null> {
  const row = await database
    .prepare(
      `SELECT id, status, deleted_at, revision, responses, answer_meta
       FROM audits WHERE id = ? AND organization_id = ?`,
    )
    .bind(auditId, organizationId)
    .first<
      Pick<
        AuditRow,
        | "answer_meta"
        | "deleted_at"
        | "id"
        | "responses"
        | "revision"
        | "status"
      >
    >();
  if (!row) return null;
  return {
    answers: Object.fromEntries(
      Object.entries(storedAnswers(row)).map(([itemId, { at, value }]) => [
        itemId,
        { at, value },
      ]),
    ),
    deleted: row.deleted_at !== null,
    id: row.id,
    revision: row.revision,
    status: row.status,
  };
}

/**
 * One `audit.answer_conflict_resolved` event per conflict, on `condition`:
 * the item, both answers with when and by whom each was given, and why the
 * kept one stayed (`later`, or `completed` for an audit already completed).
 */
async function conflictEvents(
  context: IssueContext,
  audit: AuditRow,
  conflicts: AnswerConflict[],
  sealed: boolean,
  now: string,
) {
  const items = new Map(
    storedDefinition(audit.definition).sections.flatMap((section) =>
      section.items.map((item) => [item.id, item] as const),
    ),
  );
  const people = await findPeople(
    context.env.DB,
    conflicts.flatMap(({ discarded, kept }) => [discarded.by, kept?.by]),
  );
  const answer = (stored: StoredAnswer | null) =>
    stored && {
      answeredAt: stored.at,
      answeredBy: (stored.by && people.get(stored.by)) ?? null,
      value: stored.value,
    };
  return (condition: SqlCondition) =>
    conflicts.map(({ discarded, itemId, kept }) =>
      activityStatement(
        context.env.DB,
        {
          action: "audit.answer_conflict_resolved",
          actorId: context.get("authSession").user.id,
          organizationId: context.get("organizationId"),
          occurredAt: now,
          root: { id: audit.id, type: "audit_run", label: audit.template_name },
          subject: { id: itemId, type: "audit_answer" },
          details: {
            prompt: items.get(itemId)?.prompt ?? itemId,
            responseType: items.get(itemId)?.responseType ?? "text",
            kept: answer(kept),
            discarded: answer(discarded),
            reason: sealed ? "completed" : "later",
          },
        },
        condition,
      ),
    );
}

async function findPeople(
  database: D1Database,
  ids: (string | null | undefined)[],
) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, Person>();
  const { results } = await database
    .prepare(
      `SELECT id, name, email FROM user
       WHERE id IN (${unique.map(() => "?").join(", ")})`,
    )
    .bind(...unique)
    .all<Person>();
  return new Map(results.map((person) => [person.id, { ...person }]));
}

/**
 * The form version a device downloaded, if it still exists: one published
 * when downloaded, global or the organization's own. The form may have been
 * unpublished, edited, turned off for the project, or discarded since; work
 * done on the downloaded version still syncs until the form is purged.
 */
function findSyncableVersion(
  database: D1Database,
  organizationId: string,
  templateId: string,
  version: number,
) {
  return database
    .prepare(
      `SELECT family.id, version.id AS version_id, version.version,
              version.name, version.definition
       FROM audit_template_families AS family
       JOIN audit_template_versions AS version
         ON version.template_id = family.id
       WHERE family.id = ? AND version.version = ?
         AND version.status = 'published'
         AND (family.scope = 'global' OR family.organization_id = ?)`,
    )
    .bind(templateId, version, organizationId)
    .first<{
      definition: string;
      id: string;
      name: string;
      version: number;
      version_id: string;
    }>();
}

async function issueWrites(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "issue" }>,
): Promise<OfflineWrites | string> {
  if (Boolean(operation.auditId) !== Boolean(operation.itemId))
    return "An audit issue needs an audit and checklist item.";
  const target = {
    type: operation.auditId ? ("audit_run" as const) : ("workspace" as const),
    id: operation.auditId ?? null,
    itemId: operation.itemId ?? null,
  };
  if (!(await issueTargetAvailable(context, target)))
    return "This issue's audit is unavailable. Your local work has been kept.";
  const organizationId = context.get("organizationId");
  return {
    statements: [issueInsert(context, { ...operation, target })],
    // The insert skips an assignee who has left the organization.
    applied: {
      sql: "EXISTS (SELECT 1 FROM issues WHERE id = ? AND organization_id = ?)",
      bindings: [operation.id, organizationId],
    },
    rejected: formerAssigneeError,
    retry: false,
  };
}
