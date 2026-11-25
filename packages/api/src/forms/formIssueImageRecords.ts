import type { FormIssueImage } from "@balebase/validators/forms";

export interface FormIssueImageRow {
  form_deleted_at: string | null;
  form_id: string;
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
  target_type: "form_run" | "workspace";
  uploaded_by_email: string;
  uploaded_by_id: string;
  uploaded_by_name: string;
}

export async function findFormIssueImages(
  database: D1Database,
  organizationId: string,
  formId: string,
) {
  const result = await database
    .prepare(
      `${imageSelect}
       WHERE issue.organization_id = ? AND issue.target_id = ?
         AND object.kind = 'form_issue_image'
         AND object.deletion_pending = 0
       ORDER BY image.created_at ASC`,
    )
    .bind(organizationId, formId)
    .all<FormIssueImageRow>();
  return result.results;
}

export async function findIssueImages(
  database: D1Database,
  organizationId: string,
  issueId: string,
) {
  const rows = await database
    .prepare(`${imageSelect}
    WHERE issue.organization_id = ? AND issue.id = ? AND issue.target_type IN ('workspace', 'form_run')
      AND object.kind = 'form_issue_image' AND object.deletion_pending = 0 ORDER BY image.created_at`)
    .bind(organizationId, issueId)
    .all<FormIssueImageRow>();
  return rows.results.map(toFormIssueImage);
}

export async function findFormIssueImage(
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
         AND issue.target_type IN ('form_run', 'workspace')
         AND object.kind = 'form_issue_image'
         ${includePending ? "" : "AND object.deletion_pending = 0"}`,
    )
    .bind(organizationId, issueId, imageId)
    .first<FormIssueImageRow>();
}

const imageSelect = `
  SELECT image.id, image.issue_id, image.object_id, image.created_at,
         COALESCE(issue.target_id, issue.id) AS form_id, issue.title,
         COALESCE(form.template_name, issue.title) AS template_name, issue.target_type,
         form.deleted_at AS form_deleted_at,
         object.deletion_pending,
         object.object_key, object.filename, object.content_type, object.size,
         uploader.id AS uploaded_by_id, uploader.name AS uploaded_by_name,
         uploader.email AS uploaded_by_email
  FROM form_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  LEFT JOIN forms AS form ON form.id = issue.target_id AND issue.target_type = 'form_run'
  JOIN objects AS object ON object.id = image.object_id
  JOIN user AS uploader ON uploader.id = image.uploaded_by`;

export function toFormIssueImage(row: FormIssueImageRow): FormIssueImage {
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
