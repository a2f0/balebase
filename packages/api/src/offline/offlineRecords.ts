import type { OfflineOperation } from "@balebase/validators/offline";
import { allRequiredAnswered, parseResponses } from "../audits/auditDefinition";
import { findAudit } from "../audits/auditRunRecords";
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
}

/** An issue insert skips an assignee who has left the organization. */
const formerAssigneeError =
  "The issue assignee is no longer a member. Your local work has been kept.";

/** Why a device's save of an audit no longer applies over the server's copy. */
const changedAuditError =
  "This audit changed on the server since this device last saved it. Open it online to continue; your local work has been kept.";

const invalidAnswersError =
  "An answer is not valid for this form. Your local work has been kept.";

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
 * Creates the audit in progress, then saves its answers in a second
 * statement so the audit triggers record them with the sync actor; the save
 * leaves revision 1, which the device's next save expects.
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
  const responses = parseResponses(
    operation.responses,
    storedDefinition(template.definition),
  );
  if (!responses) return invalidAnswersError;
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
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
      context.env.DB.prepare(`UPDATE audits SET responses = ?, updated_at = ?,
        activity_actor_id = ?, revision = revision + 1
        WHERE id = ? AND organization_id = ?`).bind(
        JSON.stringify(responses),
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
  };
}

/**
 * Saves answers, and completes the audit when asked, only over the revision
 * the device's last write left: an edit, completion, or discard made on the
 * server since makes the save stale rather than overwrite it.
 */
async function saveWrites(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "auditSave" }>,
): Promise<OfflineWrites | string> {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    operation.auditId,
  );
  if (!audit)
    return "This audit is no longer on the server. Your local work has been kept.";
  if (audit.deleted_at)
    return "This audit was discarded on the server. Your local work has been kept.";
  if (
    audit.status !== "in_progress" ||
    audit.revision !== operation.expectedRevision
  )
    return changedAuditError;
  const definition = storedDefinition(audit.definition);
  const responses = parseResponses(operation.responses, definition);
  if (!responses) return invalidAnswersError;
  const { completion } = operation;
  if (completion && !allRequiredAnswered(definition, responses))
    return "Complete every required item with a valid answer before syncing.";
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  // Each statement after the save runs only if the one before it wrote:
  // changes() is that statement's count.
  return {
    statements: [
      context.env.DB.prepare(`UPDATE audits SET responses = ?, status = ?,
        completed_at = ?, updated_at = ?, activity_actor_id = ?,
        revision = revision + 1
        WHERE id = ? AND organization_id = ? AND revision = ?
          AND status = 'in_progress' AND deleted_at IS NULL`).bind(
        JSON.stringify(responses),
        completion ? "completed" : "in_progress",
        completion ? now : null,
        now,
        userId,
        audit.id,
        organizationId,
        audit.revision,
      ),
      ...(completion
        ? [
            activityStatement(
              context.env.DB,
              {
                action: "audit.offline_synced",
                actorId: userId,
                organizationId,
                occurredAt: now,
                root: {
                  id: audit.id,
                  type: "audit_run",
                  label: audit.template_name,
                },
                subject: { id: audit.id, type: "audit_run" },
                details: {
                  clientStartedAt: completion.startedAt,
                  clientCompletedAt: completion.completedAt,
                },
              },
              { sql: "changes() > 0", bindings: [] },
            ),
          ]
        : []),
    ],
    applied: { sql: "changes() > 0", bindings: [] },
    rejected: changedAuditError,
  };
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
  };
}
