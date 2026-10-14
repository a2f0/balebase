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
  status: string;
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

export function toAudit(row: AuditRow) {
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
function deletedBy(row: AuditRow) {
  return row.deleted_by_id
    ? {
        email: row.deleted_by_email ?? "",
        id: row.deleted_by_id,
        name: row.deleted_by_name ?? "",
      }
    : null;
}

export function toAuditSummary(row: AuditSummaryRow) {
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
