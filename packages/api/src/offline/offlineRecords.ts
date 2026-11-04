import type { OfflineOperation } from "@balebase/validators/offline";
import { allRequiredAnswered, parseResponses } from "../audits/auditDefinition";
import { storedDefinition } from "../audits/auditTemplates";
import {
  type IssueContext,
  issueInsert,
  issueTargetAvailable,
} from "../issues/issueRecords";
import { activityStatement } from "../shared/activity";

/**
 * Why an operation's writes did not happen though their batch succeeded: an
 * issue insert skips an assignee who has left the organization.
 */
export const formerAssigneeError =
  "The issue assignee is no longer a member. Your local work has been kept.";

export async function offlineStatements(
  context: IssueContext,
  operation: OfflineOperation,
) {
  return operation.type === "audit"
    ? auditStatements(context, operation)
    : issueStatements(context, operation);
}

async function auditStatements(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "audit" }>,
) {
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
  const definition = storedDefinition(template.definition);
  const responses = parseResponses(operation.responses, definition);
  if (!responses || !allRequiredAnswered(definition, responses))
    return "Complete every required item with a valid answer before syncing.";
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  // Start and completion are separate statements in one transaction so the
  // existing audit triggers record answers and completion with the sync actor.
  return [
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
    context.env.DB.prepare(`UPDATE audits SET responses = ?, status = 'completed', completed_at = ?, updated_at = ?,
      activity_actor_id = ?, revision = revision + 1 WHERE id = ? AND organization_id = ?`).bind(
      JSON.stringify(responses),
      now,
      now,
      userId,
      operation.id,
      organizationId,
    ),
    ...offlineTiming(context, operation, template.name, now),
  ];
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

function offlineTiming(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "audit" }>,
  label: string,
  now: string,
) {
  if (!operation.startedAt || !operation.completedAt) return [];
  return [
    activityStatement(
      context.env.DB,
      {
        action: "audit.offline_synced",
        actorId: context.get("authSession").user.id,
        organizationId: context.get("organizationId"),
        occurredAt: now,
        root: { id: operation.id, type: "audit_run", label },
        subject: { id: operation.id, type: "audit_run" },
        details: {
          clientStartedAt: operation.startedAt,
          clientCompletedAt: operation.completedAt,
        },
      },
      { sql: "1", bindings: [] },
    ),
  ];
}

async function issueStatements(
  context: IssueContext,
  operation: Extract<OfflineOperation, { type: "issue" }>,
) {
  if (Boolean(operation.auditId) !== Boolean(operation.itemId))
    return "An audit issue needs an audit and checklist item.";
  const target = {
    type: operation.auditId ? ("audit_run" as const) : ("workspace" as const),
    id: operation.auditId ?? null,
    itemId: operation.itemId ?? null,
  };
  if (!(await issueTargetAvailable(context, target)))
    return "This issue's audit is unavailable. Your local work has been kept.";
  return [issueInsert(context, { ...operation, target })];
}
