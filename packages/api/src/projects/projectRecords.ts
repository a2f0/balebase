import type {
  DeletedProject,
  Project,
  ProjectSummary,
} from "@balebase/validators/projects";
import {
  projectFormFilter,
  type TemplateRow,
  templateSelect,
  toTemplate,
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

// People count only while they belong to the organization, as `current`
// requires. Forms count only while published: a form that is unpublished, or
// an organization draft, stays turned on but is not listed or downloaded.
/** Whether the `person` project membership's user is in its organization. */
const currentMember = `EXISTS (
  SELECT 1 FROM member
  WHERE member.organizationId = person.organization_id
    AND member.userId = person.user_id)`;

const projectSelect = `
  SELECT project.id, project.name, project.description, project.revision,
         project.created_at, project.updated_at,
         (SELECT COUNT(*) FROM project_members AS person
          WHERE person.project_id = project.id AND ${currentMember}
         ) AS member_count,
         (SELECT COUNT(*) FROM project_audit_forms AS enabled
          JOIN audit_template_families AS family ON family.id = enabled.template_id
          JOIN audit_template_versions AS version
            ON version.template_id = family.id
           AND version.version = family.current_version
          WHERE enabled.project_id = project.id
            AND ${projectFormFilter("project.organization_id")}
         ) AS form_count,
         EXISTS (SELECT 1 FROM project_members AS person
                 WHERE person.project_id = project.id AND person.user_id = ?
                   AND ${currentMember}) AS is_member
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
       WHERE project.organization_id = ? AND project.deleted_at IS NULL
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
      `${projectSelect}
       WHERE project.id = ? AND project.organization_id = ?
         AND project.deleted_at IS NULL`,
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
         WHERE person.project_id = ? AND ${currentMember}
         ORDER BY user.name COLLATE NOCASE, user.id`,
      )
      .bind(id)
      .all<{ email: string; id: string; name: string }>(),
    database
      .prepare(
        `${templateSelect}
         JOIN project_audit_forms AS enabled ON enabled.template_id = family.id
         WHERE enabled.project_id = ? AND ${projectFormFilter()}
         ORDER BY version.name COLLATE NOCASE, family.id`,
      )
      .bind(id, organizationId)
      .all<TemplateRow>(),
  ]);
  return {
    ...toSummary(row),
    forms: forms.results.map(toTemplate),
    members: members.results,
  };
}

/** The organization's deleted projects, most recently deleted first. */
export async function listDeletedProjects(
  database: D1Database,
  organizationId: string,
): Promise<DeletedProject[]> {
  const { results } = await database
    .prepare(
      `SELECT project.id, project.name, project.description, project.deleted_at,
              deleter.id AS deleter_id, deleter.name AS deleter_name,
              deleter.email AS deleter_email
       FROM projects AS project
       LEFT JOIN user AS deleter ON deleter.id = project.deleted_by_user_id
       WHERE project.organization_id = ? AND project.deleted_at IS NOT NULL
       ORDER BY project.deleted_at DESC, project.id`,
    )
    .bind(organizationId)
    .all<{
      deleted_at: string;
      deleter_email: string | null;
      deleter_id: string | null;
      deleter_name: string | null;
      description: string;
      id: string;
      name: string;
    }>();
  return results.map((row) => ({
    deletedAt: row.deleted_at,
    deletedBy:
      row.deleter_id && row.deleter_email
        ? {
            email: row.deleter_email,
            id: row.deleter_id,
            name: row.deleter_name ?? "",
          }
        : null,
    description: row.description,
    id: row.id,
    name: row.name,
  }));
}

/** Every published audit form the organization can turn on for a project. */
export async function listAvailableForms(
  database: D1Database,
  organizationId: string,
) {
  const { results } = await database
    .prepare(
      `${templateSelect}
       WHERE ${projectFormFilter()}
       ORDER BY version.name COLLATE NOCASE, family.id`,
    )
    .bind(organizationId)
    .all<TemplateRow>();
  return results.map(toTemplate);
}

/** One published form the organization can turn on for a project, or null. */
export async function findAvailableForm(
  database: D1Database,
  organizationId: string,
  templateId: string,
) {
  const row = await database
    .prepare(`${templateSelect} WHERE family.id = ? AND ${projectFormFilter()}`)
    .bind(templateId, organizationId)
    .first<TemplateRow>();
  return row ? toTemplate(row) : null;
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
