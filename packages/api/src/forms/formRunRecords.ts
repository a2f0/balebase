import type { Person } from "@balebase/validators/fields";
import type {
  FormIssue,
  FormRun,
  FormStatus,
  FormSummary,
} from "@balebase/validators/forms";
import { storedDefinition } from "./formTemplates";

export interface FormRow {
  /** Each answer's time and author, by item ID; see `formAnswers.ts`. */
  answer_meta: string;
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
  project_deleted_at: string | null;
  project_id: string;
  project_name: string;
  responses: string;
  revision: number;
  status: FormStatus;
  template_family_id: string | null;
  template_id: string | null;
  template_name: string;
  template_version: number | null;
  updated_at: string;
}

/** Form lists read no answer times. */
export interface FormSummaryRow extends Omit<FormRow, "answer_meta"> {
  issue_count: number;
}

export const discardedFormError = "This form was discarded.";

/** The form's project, selected from `forms AS form` joined to `projects AS project`. */
export const formProjectColumns = `project.id AS project_id,
  project.name AS project_name, project.deleted_at AS project_deleted_at`;

export async function findForm(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return formStatement(database, organizationId, id).first<FormRow>();
}

export function formStatement(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT form.id, form.template_id, form.template_family_id, form.template_version,
              form.template_name, form.definition, form.responses, form.answer_meta,
              form.status, form.completed_at,
              form.created_at, form.updated_at, form.revision,
              creator.id AS created_by_id, creator.name AS created_by_name,
              creator.email AS created_by_email,
              form.deleted_at, deleted_by.id AS deleted_by_id,
              deleted_by.name AS deleted_by_name,
              deleted_by.email AS deleted_by_email, ${formProjectColumns}
       FROM forms AS form JOIN user AS creator ON creator.id = form.started_by
       JOIN projects AS project ON project.id = form.project_id
       LEFT JOIN user AS deleted_by ON deleted_by.id = form.deleted_by_user_id
       WHERE form.id = ? AND form.organization_id = ?`,
    )
    .bind(id, organizationId);
}

export function discardRejection(form: FormRow) {
  if (form.deleted_at) return discardedFormError;
  return form.status === "in_progress"
    ? undefined
    : "Only in-progress forms can be discarded.";
}

/** The stored form; the run page adds who last saved each answer. */
export function toForm(
  row: Omit<FormRow, "answer_meta">,
): Omit<FormRun, "answerActivity"> {
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
    project: {
      deleted: row.project_deleted_at !== null,
      id: row.project_id,
      name: row.project_name,
    },
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
function deletedBy(row: Omit<FormRow, "answer_meta">): Person | null {
  return row.deleted_by_id
    ? {
        email: row.deleted_by_email ?? "",
        id: row.deleted_by_id,
        name: row.deleted_by_name ?? "",
      }
    : null;
}

export function toFormSummary(row: FormSummaryRow): FormSummary {
  const form = toForm(row);
  return {
    completedAt: form.completedAt,
    createdAt: form.createdAt,
    createdBy: form.createdBy,
    deletedAt: form.deletedAt,
    deletedBy: form.deletedBy,
    id: form.id,
    issueCount: row.issue_count,
    project: form.project,
    responseCount: Object.keys(form.responses).length,
    status: form.status,
    templateName: form.templateName,
    templateVersion: form.templateVersion,
    updatedAt: form.updatedAt,
  };
}

/** Binds one issue id; true unless that issue's form has been discarded. */
export const issueFormNotDiscarded = `NOT EXISTS (
  SELECT 1 FROM issues AS guarded_issue
  JOIN forms AS guarded_form ON guarded_form.id = guarded_issue.target_id AND guarded_issue.target_type = 'form_run'
  WHERE guarded_issue.id = ? AND guarded_form.deleted_at IS NOT NULL
)`;

export async function issueFormDiscarded(
  database: D1Database,
  organizationId: string,
  issueId: string,
) {
  const issue = await database
    .prepare(
      `SELECT form.deleted_at
       FROM issues AS issue
       JOIN forms AS form ON form.id = issue.target_id AND issue.target_type = 'form_run'
       WHERE issue.id = ? AND issue.organization_id = ?`,
    )
    .bind(issueId, organizationId)
    .first<{ deleted_at: string | null }>();
  return Boolean(issue?.deleted_at);
}

/** Binds one image id; true unless that image's form has been discarded. */
export const imageFormNotDiscarded = `NOT EXISTS (
  SELECT 1 FROM form_issue_images AS guarded_image
  JOIN issues AS guarded_issue ON guarded_issue.id = guarded_image.issue_id
  JOIN forms AS guarded_form ON guarded_form.id = guarded_issue.target_id AND guarded_issue.target_type = 'form_run'
  WHERE guarded_image.id = ? AND guarded_form.deleted_at IS NOT NULL
)`;

export function findIssueForUpdate(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT issue.id, issue.status, issue.assigned_to,
              form.deleted_at AS form_deleted_at
       FROM issues AS issue
       JOIN forms AS form ON form.id = issue.target_id AND issue.target_type = 'form_run'
       WHERE issue.id = ? AND issue.organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{
      assigned_to: string | null;
      form_deleted_at: string | null;
      id: string;
      status: FormIssue["status"];
    }>();
}
