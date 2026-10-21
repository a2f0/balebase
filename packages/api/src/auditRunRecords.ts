import type {
  AuditIssue,
  AuditPerson,
  AuditRun,
  AuditStatus,
  AuditSummary,
} from "@balebase/validators/audits";
import { storedDefinition } from "./auditTemplates";

export interface AuditRow {
  completed_at: string | null;
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  definition: string;
  deleted_at: string | null;
  deleted_by_email: string | null;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
  id: string;
  responses: string;
  revision: number;
  status: AuditStatus;
  template_family_id: string | null;
  template_id: string | null;
  template_name: string;
  template_version: number | null;
  updated_at: string;
}

export interface AuditSummaryRow extends AuditRow {
  issue_count: number;
}

export const discardedAuditError = "This audit was discarded.";

export async function findAudit(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return auditStatement(database, organizationId, id).first<AuditRow>();
}

export function auditStatement(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT audit.id, audit.template_id, audit.template_family_id, audit.template_version,
              audit.template_name, audit.definition, audit.responses, audit.status, audit.completed_at,
              audit.created_at, audit.updated_at, audit.revision,
              creator.id AS created_by_id, creator.name AS created_by_name,
              creator.email AS created_by_email,
              audit.deleted_at, deleted_by.id AS deleted_by_id,
              deleted_by.name AS deleted_by_name,
              deleted_by.email AS deleted_by_email
       FROM audits AS audit JOIN user AS creator ON creator.id = audit.started_by
       LEFT JOIN user AS deleted_by ON deleted_by.id = audit.deleted_by_user_id
       WHERE audit.id = ? AND audit.organization_id = ?`,
    )
    .bind(id, organizationId);
}

export function discardRejection(audit: AuditRow) {
  if (audit.deleted_at) return discardedAuditError;
  return audit.status === "in_progress"
    ? undefined
    : "Only in-progress audits can be discarded.";
}

/** The stored audit; the run page adds who last saved each answer. */
export function toAudit(row: AuditRow): Omit<AuditRun, "answerActivity"> {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    createdBy: {
      email: row.created_by_email,
      id: row.created_by_id,
      name: row.created_by_name,
    },
    definition: storedDefinition(row.definition),
    deletedAt: row.deleted_at,
    deletedBy: deletedBy(row),
    id: row.id,
    responses: JSON.parse(row.responses) as Record<string, string>,
    revision: row.revision,
    status: row.status,
    templateId: row.template_family_id ?? row.template_id,
    templateName: row.template_name,
    templateVersion: row.template_version,
    updatedAt: row.updated_at,
  };
}

/** The discarding user, or null once that account has been deleted. */
function deletedBy(row: AuditRow): AuditPerson | null {
  return row.deleted_by_id
    ? {
        email: row.deleted_by_email ?? "",
        id: row.deleted_by_id,
        name: row.deleted_by_name ?? "",
      }
    : null;
}

export function toAuditSummary(row: AuditSummaryRow): AuditSummary {
  const audit = toAudit(row);
  return {
    completedAt: audit.completedAt,
    createdAt: audit.createdAt,
    createdBy: audit.createdBy,
    deletedAt: audit.deletedAt,
    deletedBy: audit.deletedBy,
    id: audit.id,
    issueCount: row.issue_count,
    responseCount: Object.keys(audit.responses).length,
    status: audit.status,
    templateName: audit.templateName,
    templateVersion: audit.templateVersion,
    updatedAt: audit.updatedAt,
  };
}

/** Binds one issue id; true unless that issue's audit has been discarded. */
export const issueAuditNotDiscarded = `NOT EXISTS (
  SELECT 1 FROM issues AS guarded_issue
  JOIN audits AS guarded_audit ON guarded_audit.id = guarded_issue.target_id AND guarded_issue.target_type = 'audit_run'
  WHERE guarded_issue.id = ? AND guarded_audit.deleted_at IS NOT NULL
)`;

export async function issueAuditDiscarded(
  database: D1Database,
  organizationId: string,
  issueId: string,
) {
  const issue = await database
    .prepare(
      `SELECT audit.deleted_at
       FROM issues AS issue
       JOIN audits AS audit ON audit.id = issue.target_id AND issue.target_type = 'audit_run'
       WHERE issue.id = ? AND issue.organization_id = ?`,
    )
    .bind(issueId, organizationId)
    .first<{ deleted_at: string | null }>();
  return Boolean(issue?.deleted_at);
}

/** Binds one image id; true unless that image's audit has been discarded. */
export const imageAuditNotDiscarded = `NOT EXISTS (
  SELECT 1 FROM audit_issue_images AS guarded_image
  JOIN issues AS guarded_issue ON guarded_issue.id = guarded_image.issue_id
  JOIN audits AS guarded_audit ON guarded_audit.id = guarded_issue.target_id AND guarded_issue.target_type = 'audit_run'
  WHERE guarded_image.id = ? AND guarded_audit.deleted_at IS NOT NULL
)`;

export function findIssueForUpdate(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT issue.id, issue.status, issue.assigned_to,
              audit.deleted_at AS audit_deleted_at
       FROM issues AS issue
       JOIN audits AS audit ON audit.id = issue.target_id AND issue.target_type = 'audit_run'
       WHERE issue.id = ? AND issue.organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{
      assigned_to: string | null;
      audit_deleted_at: string | null;
      id: string;
      status: AuditIssue["status"];
    }>();
}
