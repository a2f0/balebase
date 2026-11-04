import type { OfflineSync } from "@balebase/validators/offline";
import {
  projectFormFilter,
  type TemplateRow,
  templateSelect,
  toTemplate,
} from "../audits/auditTemplates";

// A project membership counts only while the person is in the organization.
const currentMember = `EXISTS (
  SELECT 1 FROM member
  WHERE member.organizationId = person.organization_id
    AND member.userId = person.user_id)`;

/**
 * What `userId`'s devices keep in the organization, or only the cursor when
 * it is still `after`. The counters and the set are read in one batch, which
 * D1 runs as one transaction, so the cursor names exactly the state the set
 * was read from: a change committed after it moves the counters past the
 * cursor and the next sync reads it.
 */
export async function readOfflineSync(
  database: D1Database,
  organizationId: string,
  userId: string,
  after: string | undefined,
): Promise<OfflineSync> {
  const [revisions, projects, forms, members] = await database.batch([
    database
      .prepare(
        `SELECT
           (SELECT revision FROM offline_sync_revisions WHERE scope = ?)
             AS organization,
           (SELECT revision FROM offline_sync_revisions WHERE scope = 'global')
             AS global`,
      )
      .bind(organizationId),
    database
      .prepare(
        `SELECT project.id, project.name, project.description
         FROM projects AS project
         JOIN project_members AS person ON person.project_id = project.id
         WHERE project.organization_id = ? AND person.user_id = ?
           AND project.deleted_at IS NULL AND ${currentMember}
         ORDER BY project.name COLLATE NOCASE, project.id`,
      )
      .bind(organizationId, userId),
    database
      .prepare(
        `${templateSelect.replace("SELECT", "SELECT enabled.project_id,")}
         JOIN project_audit_forms AS enabled ON enabled.template_id = family.id
         JOIN project_members AS person
           ON person.project_id = enabled.project_id
         JOIN projects AS project ON project.id = enabled.project_id
         WHERE enabled.organization_id = ? AND person.user_id = ?
           AND project.deleted_at IS NULL
           AND ${currentMember}
           AND ${projectFormFilter("enabled.organization_id")}
         ORDER BY version.name COLLATE NOCASE, family.id`,
      )
      .bind(organizationId, userId),
    database
      .prepare(
        `SELECT user.id, user.name, user.email
         FROM member JOIN user ON user.id = member.userId
         WHERE member.organizationId = ?
         ORDER BY user.name COLLATE NOCASE, user.id`,
      )
      .bind(organizationId),
  ]);
  const counters = revisions?.results[0] as
    | { global: number | null; organization: number | null }
    | undefined;
  const cursor = `${counters?.organization ?? 0}.${counters?.global ?? 0}`;
  if (cursor === after) return { changed: false, cursor };
  const bindings = (forms?.results ?? []) as (TemplateRow & {
    project_id: string;
  })[];
  const templates = new Map<string, TemplateRow>();
  for (const row of bindings) templates.set(row.id, row);
  return {
    changed: true,
    cursor,
    forms: [...templates.values()].map(toTemplate),
    members: (members?.results ?? []) as {
      email: string;
      id: string;
      name: string;
    }[],
    projects: (
      (projects?.results ?? []) as {
        description: string;
        id: string;
        name: string;
      }[]
    ).map((project) => ({
      ...project,
      formIds: bindings
        .filter((row) => row.project_id === project.id)
        .map((row) => row.id),
    })),
  };
}
