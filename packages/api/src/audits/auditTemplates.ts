import {
  type AuditDefinition,
  AuditDefinitionSchema,
  type AuditTemplate,
  type AuditTemplateSaveSchema,
  type AuditTemplateScope,
  type AuditTemplateSummary,
  type AuditTemplateVersion,
} from "@balebase/validators/audits";
import type { Person } from "@balebase/validators/fields";
import type { z } from "zod";
import { type ActivityActor, activityBatch } from "../shared/activity";

export interface TemplateRow {
  created_at: string;
  current_version: number;
  definition: string;
  description: string;
  id: string;
  name: string;
  scope: AuditTemplateScope;
  status: string;
  updated_at: string;
  version: number;
  version_created_at: string;
  version_created_by_email: string;
  version_created_by_id: string;
  version_created_by_name: string;
  version_id: string;
}

interface TemplateVersionRow {
  created_at: string;
  created_by_email: string;
  created_by_id: string;
  created_by_name: string;
  version: number;
}

export type TemplateSaveInput = z.output<typeof AuditTemplateSaveSchema>;

const templateColumns = `
  family.id,
  family.scope,
  family.current_version,
  family.created_at,
  family.updated_at,
  version.id AS version_id,
  version.version,
  version.name,
  version.description,
  version.definition,
  version.status,
  version.created_at AS version_created_at,
  version.created_by AS version_created_by_id,
  creator.name AS version_created_by_name,
  creator.email AS version_created_by_email`;

const templateFrom = `
  FROM audit_template_families AS family
  JOIN audit_template_versions AS version
    ON version.template_id = family.id
   AND version.version = family.current_version
  JOIN user AS creator ON creator.id = version.created_by`;

export const templateSelect = `
  SELECT ${templateColumns}
  ${templateFrom}`;

/**
 * `templateSelect` with each form's `audit_count`: audits started from any of
 * its versions that were not discarded. With `organization`, the SQL naming
 * an organization ID, only that organization's audits count; otherwise every
 * organization's do.
 */
export function templateSummarySelect(organization?: string) {
  const owner = organization ? `AND run.organization_id = ${organization}` : "";
  return `
  SELECT ${templateColumns},
         (SELECT COUNT(*) FROM audits AS run
          WHERE run.template_family_id = family.id
            AND run.deleted_at IS NULL ${owner}) AS audit_count
  ${templateFrom}`;
}

/**
 * Limits `templateSelect` to the forms an organization can use: published
 * global forms and its own. `organization` is the SQL naming the
 * organization ID; by default a parameter to bind.
 */
export function visibleTemplateFilter(organization = "?") {
  return `((family.scope = 'global' AND version.status = 'published')
    OR family.organization_id = ${organization})`;
}

/**
 * Limits `templateSelect` to the forms an organization can turn on for its
 * projects: published global forms and its own published forms. Members
 * download these for offline work, so drafts and unpublished forms are left
 * out.
 */
export function projectFormFilter(organization = "?") {
  return `(version.status = 'published'
    AND (family.scope = 'global' OR family.organization_id = ${organization}))`;
}

export const staleTemplateError =
  "This template has a newer version. Reload it before saving.";

/** Created by migration 0033; attributed with the built-in templates. */
export const auditLibraryActor = {
  email: "audit-library@system.invalid",
  id: "system:audit-library",
  name: "Stealth audit library",
} as const;

/**
 * Creates a blank template at version one: an organization's, when the
 * organization is still under its template limit, or a global one when no
 * organization is given. Returns null when the limit is reached.
 */
export async function createTemplate(
  database: D1Database,
  input: {
    actor: ActivityActor;
    name: string;
    organizationId: string | null;
    templateLimit: number | null;
  },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await activityBatch(database, input.actor.apiKey, [
    database
      .prepare(
        `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
         SELECT ?, ?, ?, 1, ?, ?, ?
         WHERE ? IS NULL OR (
           SELECT COUNT(*) FROM audit_template_families
           WHERE scope = 'organization' AND organization_id = ?
         ) < ?`,
      )
      .bind(
        id,
        input.organizationId ? "organization" : "global",
        input.organizationId,
        input.actor.userId,
        now,
        now,
        input.templateLimit,
        input.organizationId,
        input.templateLimit,
      ),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         SELECT ?, ?, 1, ?, '', ?, 'draft', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM audit_template_families WHERE id = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        input.name,
        JSON.stringify(blankDefinition()),
        input.actor.userId,
        now,
        id,
      ),
  ]);
  if (!Number(results[0]?.meta.changes)) return null;
  const template = await findTemplate(database, input.organizationId, id);
  if (!template) throw new Error("Created template could not be loaded.");
  return template;
}

/**
 * Saves the input as the template's next version. Returns "stale" when the
 * input was edited from an older version or another save won the race.
 */
export async function saveTemplateVersion(
  database: D1Database,
  organizationId: string | null,
  current: TemplateRow,
  actor: ActivityActor,
  input: TemplateSaveInput,
  status = current.status,
) {
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== current.current_version
  ) {
    return "stale" as const;
  }
  try {
    await addTemplateVersion(
      database,
      current,
      actor,
      input,
      new Date().toISOString(),
      status,
    );
  } catch (cause) {
    const latest = await loadTemplate(database, organizationId, current.id);
    if (latest && latest.current_version !== current.current_version) {
      return "stale" as const;
    }
    throw cause;
  }
  const saved = await loadTemplate(database, organizationId, current.id);
  if (!saved) throw new Error("Saved template could not be loaded.");
  return saved;
}

async function addTemplateVersion(
  database: D1Database,
  current: TemplateRow,
  actor: ActivityActor,
  input: TemplateSaveInput,
  now: string,
  status: string,
) {
  const version = current.current_version + 1;
  await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `UPDATE audit_template_families
         SET current_version = ?, updated_at = ?
         WHERE id = ? AND current_version = ?`,
      )
      .bind(version, now, current.id, current.current_version),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        current.id,
        version,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        status,
        actor.userId,
        now,
      ),
  ]);
}

export async function listTemplateVersions(
  database: D1Database,
  templateId: string,
  publishedOnly = false,
) {
  const result = await database
    .prepare(
      `SELECT version.version, version.created_at,
              version.created_by AS created_by_id,
              creator.name AS created_by_name,
              creator.email AS created_by_email
       FROM audit_template_versions AS version
       JOIN user AS creator ON creator.id = version.created_by
       WHERE version.template_id = ?
         ${publishedOnly ? "AND version.status = 'published'" : ""}
       ORDER BY version.version DESC`,
    )
    .bind(templateId)
    .all<TemplateVersionRow>();
  return result.results.map(toTemplateVersion);
}

/**
 * A global template, or one of the organization's own. With no organization,
 * only global templates match.
 */
export async function findTemplate(
  database: D1Database,
  organizationId: string | null,
  id: string,
  version?: number,
) {
  const current = await loadTemplate(database, organizationId, id);
  if (
    !current ||
    current.status === "discarded" ||
    (organizationId !== null &&
      current.scope === "global" &&
      current.status !== "published")
  )
    return null;
  const selected = version
    ? await loadTemplate(database, organizationId, id, version)
    : current;
  return organizationId !== null &&
    selected?.scope === "global" &&
    selected.status !== "published"
    ? null
    : selected;
}

/**
 * A discarded global form that has not been purged yet, with the status a
 * restore gives it: the one it had before the discard, except that a form is
 * never published again by a restore.
 */
export async function findDiscardedTemplate(database: D1Database, id: string) {
  const current = await loadTemplate(database, null, id);
  if (current?.scope !== "global" || current.status !== "discarded")
    return null;
  const previous =
    current.current_version > 1
      ? await loadTemplate(database, null, id, current.current_version - 1)
      : null;
  const restoredStatus: "draft" | "unpublished" =
    previous?.status === "draft" ? "draft" : "unpublished";
  return { current, restoredStatus };
}

/**
 * A global form, or one of its versions, including a discarded form the purge
 * has not deleted yet. Only root admins may read through this: organizations
 * must use `findTemplate`, which hides forms that are not published.
 */
export async function findRetainedGlobalTemplate(
  database: D1Database,
  id: string,
  version?: number,
) {
  const current = await loadTemplate(database, null, id);
  if (current?.scope !== "global") return null;
  return version ? loadTemplate(database, null, id, version) : current;
}

/** Internal reads also see discarded forms so concurrent writes report stale. */
async function loadTemplate(
  database: D1Database,
  organizationId: string | null,
  id: string,
  version?: number,
) {
  const versionJoin = version
    ? "version.version = ?"
    : "version.version = family.current_version";
  const statement = database.prepare(
    `SELECT ${templateColumns}
     FROM audit_template_families AS family
     JOIN audit_template_versions AS version
       ON version.template_id = family.id AND ${versionJoin}
     JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ?
       AND (family.scope = 'global' OR family.organization_id = ?)`,
  );
  return version
    ? statement.bind(version, id, organizationId).first<TemplateRow>()
    : statement.bind(id, organizationId).first<TemplateRow>();
}

export function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function blankDefinition(): AuditDefinition {
  return {
    sections: [
      {
        id: crypto.randomUUID(),
        items: [
          {
            id: crypto.randomUUID(),
            prompt: "Untitled question",
            required: true,
            responseType: "check",
          },
        ],
        title: "Untitled section",
      },
    ],
    version: 1,
  };
}

export function storedDefinition(value: string) {
  const definition = AuditDefinitionSchema.safeParse(JSON.parse(value));
  if (!definition.success)
    throw new Error("Stored audit definition is invalid.");
  return definition.data;
}

export function toTemplate(row: TemplateRow): AuditTemplate {
  return {
    createdAt: row.created_at,
    currentVersion: row.current_version,
    definition: storedDefinition(row.definition),
    description: row.description,
    id: row.id,
    name: row.name,
    savedAt: row.version_created_at,
    savedBy: templateActor(
      row.version_created_by_id,
      row.version_created_by_name,
      row.version_created_by_email,
    ),
    scope: row.scope,
    status: row.status,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function toTemplateSummary(
  row: TemplateRow & { audit_count: number },
): AuditTemplateSummary {
  return { ...toTemplate(row), auditCount: row.audit_count };
}

function toTemplateVersion(row: TemplateVersionRow): AuditTemplateVersion {
  return {
    createdAt: row.created_at,
    createdBy: templateActor(
      row.created_by_id,
      row.created_by_name,
      row.created_by_email,
    ),
    version: row.version,
  };
}

function templateActor(id: string, name: string, email: string): Person {
  return id === auditLibraryActor.id ? auditLibraryActor : { email, id, name };
}
