import type { AuditIssueImage } from "@balebase/validators/audits";

export interface AuditIssueImageRow {
  audit_deleted_at: string | null;
  audit_id: string;
  content_type: string;
  created_at: string;
  deletion_pending: number;
  filename: string;
  id: string;
  issue_id: string;
  object_id: string;
  object_key: string;
  size: number;
  template_name: string;
  title: string;
  target_type: "audit_run" | "workspace";
  uploaded_by_email: string;
  uploaded_by_id: string;
  uploaded_by_name: string;
}

export async function findAuditIssueImages(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  const result = await database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.target_id = ?
         AND object.kind = 'audit_issue_image'
         AND object.deletion_pending = 0
       ORDER BY image.created_at ASC`,
    )
    .bind(organizationId, auditId)
    .all<AuditIssueImageRow>();
  return result.results;
}

export async function findIssueImages(
  database: D1Database,
  organizationId: string,
  issueId: string,
) {
  const rows = await database
    .prepare(`${imageSelect}
    WHERE issue.organization_id = ? AND issue.id = ? AND issue.target_type IN ('workspace', 'audit_run')
      AND object.kind = 'audit_issue_image' AND object.deletion_pending = 0 ORDER BY image.created_at`)
    .bind(organizationId, issueId)
    .all<AuditIssueImageRow>();
  return rows.results.map(toAuditIssueImage);
}

export async function findAuditIssueImage(
  database: D1Database,
  organizationId: string,
  issueId: string,
  imageId: string,
  includePending = false,
) {
  return database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.id = ? AND image.id = ?
         AND issue.target_type IN ('audit_run', 'workspace')
         AND object.kind = 'audit_issue_image'
         ${includePending ? "" : "AND object.deletion_pending = 0"}`,
    )
    .bind(organizationId, issueId, imageId)
    .first<AuditIssueImageRow>();
}

const imageSelect = `
  SELECT image.id, image.issue_id, image.object_id, image.created_at,
         COALESCE(issue.target_id, issue.id) AS audit_id, issue.title,
         COALESCE(audit.template_name, issue.title) AS template_name, issue.target_type,
         audit.deleted_at AS audit_deleted_at,
         object.deletion_pending,
         object.object_key, object.filename, object.content_type, object.size,
         uploader.id AS uploaded_by_id, uploader.name AS uploaded_by_name,
         uploader.email AS uploaded_by_email
  FROM audit_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  LEFT JOIN audits AS audit ON audit.id = issue.target_id AND issue.target_type = 'audit_run'
  JOIN objects AS object ON object.id = image.object_id
  JOIN user AS uploader ON uploader.id = image.uploaded_by`;

export function toAuditIssueImage(row: AuditIssueImageRow): AuditIssueImage {
  return {
    contentType: row.content_type,
    createdAt: row.created_at,
    filename: row.filename,
    id: row.id,
    size: row.size,
    uploadedBy: {
      email: row.uploaded_by_email,
      id: row.uploaded_by_id,
      name: row.uploaded_by_name,
    },
  };
}
