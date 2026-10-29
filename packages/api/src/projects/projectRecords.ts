import type {
  Project,
  ProjectForm,
  ProjectSummary,
} from "@balebase/validators/projects";
import {
  type TemplateRow,
  templateSelect,
  visibleTemplateFilter,
} from "../audits/auditTemplates";

interface ProjectRow {
  created_at: string;
  description: string;
  form_count: number;
  id: string;
  is_member: number;
  member_count: number;
  name: string;
  revision: number;
  updated_at: string;
}

// Forms count only while the organization can still use them: a global form
// that is unpublished stays turned on but is not offered or downloaded.
const projectSelect = `
  SELECT project.id, project.name, project.description, project.revision,
         project.created_at, project.updated_at,
         (SELECT COUNT(*) FROM project_members AS person
          WHERE person.project_id = project.id) AS member_count,
         (SELECT COUNT(*) FROM project_audit_forms AS enabled
          JOIN audit_template_families AS family ON family.id = enabled.template_id
          JOIN audit_template_versions AS version
            ON version.template_id = family.id
           AND version.version = family.current_version
          WHERE enabled.project_id = project.id
            AND ${visibleTemplateFilter("project.organization_id")}
         ) AS form_count,
         EXISTS (SELECT 1 FROM project_members AS person
                 WHERE person.project_id = project.id AND person.user_id = ?)
           AS is_member
  FROM projects AS project`;

/** The organization's projects, by name, marking the ones `userId` is on. */
export async function listProjects(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  const { results } = await database
    .prepare(
      `${projectSelect}
       WHERE project.organization_id = ?
       ORDER BY project.name COLLATE NOCASE, project.id`,
    )
    .bind(userId, organizationId)
    .all<ProjectRow>();
  return results.map(toSummary);
}

export function findProjectRow(
  database: D1Database,
  organizationId: string,
  id: string,
  userId: string,
) {
  return database
    .prepare(
      `${projectSelect} WHERE project.id = ? AND project.organization_id = ?`,
    )
    .bind(userId, id, organizationId)
    .first<ProjectRow>();
}

/** A project with its members and the forms turned on for it. */
export async function findProject(
  database: D1Database,
  organizationId: string,
  id: string,
  userId: string,
): Promise<Project | null> {
  const row = await findProjectRow(database, organizationId, id, userId);
  if (!row) return null;
  const [members, forms] = await Promise.all([
    database
      .prepare(
        `SELECT user.id, user.name, user.email
         FROM project_members AS person
         JOIN user ON user.id = person.user_id
         WHERE person.project_id = ?
         ORDER BY user.name COLLATE NOCASE, user.id`,
      )
      .bind(id)
      .all<{ email: string; id: string; name: string }>(),
    database
      .prepare(
        `${templateSelect}
         JOIN project_audit_forms AS enabled ON enabled.template_id = family.id
         WHERE enabled.project_id = ? AND ${visibleTemplateFilter()}
         ORDER BY version.name COLLATE NOCASE, family.id`,
      )
      .bind(id, organizationId)
      .all<TemplateRow>(),
  ]);
  return {
    ...toSummary(row),
    forms: forms.results.map(toProjectForm),
    members: members.results,
  };
}

/** Every audit form the organization can turn on for a project. */
export async function listAvailableForms(
  database: D1Database,
  organizationId: string,
) {
  const { results } = await database
    .prepare(
      `${templateSelect}
       WHERE ${visibleTemplateFilter()}
       ORDER BY version.name COLLATE NOCASE, family.id`,
    )
    .bind(organizationId)
    .all<TemplateRow>();
  return results.map(toProjectForm);
}

/** One form the organization can use, or null. */
export async function findAvailableForm(
  database: D1Database,
  organizationId: string,
  templateId: string,
) {
  const row = await database
    .prepare(
      `${templateSelect} WHERE family.id = ? AND ${visibleTemplateFilter()}`,
    )
    .bind(templateId, organizationId)
    .first<TemplateRow>();
  return row ? toProjectForm(row) : null;
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    createdAt: row.created_at,
    description: row.description,
    formCount: row.form_count,
    id: row.id,
    isMember: Boolean(row.is_member),
    memberCount: row.member_count,
    name: row.name,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function toProjectForm(row: TemplateRow): ProjectForm {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    version: row.version,
  };
}
