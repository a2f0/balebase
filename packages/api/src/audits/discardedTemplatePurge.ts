import { discardedTemplateRetentionDays } from "@balebase/validators/rules";
import {
  maintenanceActor,
  systemActivityRowsStatement,
} from "../shared/activity";
import type { Bindings } from "../types";

const batchSize = 100;

/** Global forms discarded on or before the bound cutoff. */
const discardedFamilies = `SELECT family.id
  FROM audit_template_families AS family
  JOIN audit_template_versions AS version
    ON version.template_id = family.id
   AND version.version = family.current_version
  WHERE family.scope = 'global' AND version.status = 'discarded'
    AND julianday(version.created_at) <= julianday(?)`;

/**
 * Permanently deletes up to 100 global forms discarded at least 30 days ago,
 * with their versions and history. Audits started from them keep their
 * snapshots; each project that had one turned on records its removal
 * (`project.form_disabled` with `reason: form_purged`) by the job. The events
 * and deletion share one batch that rechecks eligibility, so a restore
 * committed first keeps the form and records nothing.
 */
export async function purgeDiscardedAuditForms(
  environment: Pick<Bindings, "DB">,
  runId: string,
  now = new Date(),
) {
  const cutoff = new Date(
    now.getTime() - discardedTemplateRetentionDays * 86400000,
  ).toISOString();
  const database = environment.DB;
  const candidates = await database
    .prepare(
      `${discardedFamilies}
       ORDER BY julianday(version.created_at), family.id
       LIMIT ?`,
    )
    .bind(cutoff, batchSize)
    .all<{ id: string }>();
  if (!candidates.results.length) return 0;
  const ids = JSON.stringify(candidates.results.map(({ id }) => id));
  const [, deleted] = await database.batch<{ id: string }>([
    // Organizations only ever saw a global form's published versions.
    systemActivityRowsStatement(
      database,
      maintenanceActor("purgeDiscardedAuditForms", runId),
      now.toISOString(),
      {
        bindings: [ids, cutoff],
        sql: `SELECT project.organization_id, 'project' AS root_type,
                     project.id AS root_id, project.name AS root_label,
                     'audit_template' AS subject_type,
                     link.template_id AS subject_id,
                     'project.form_disabled' AS action,
                     json_object(
                       'templateId', link.template_id,
                       'title', COALESCE((
                         SELECT version.name FROM audit_template_versions AS version
                         WHERE version.template_id = link.template_id
                           AND version.status = 'published'
                         ORDER BY version.version DESC LIMIT 1
                       ), ''),
                       'reason', 'form_purged'
                     ) AS details
              FROM project_audit_forms AS link
              JOIN projects AS project ON project.id = link.project_id
              WHERE link.template_id IN (SELECT value FROM json_each(?))
                AND link.template_id IN (${discardedFamilies})`,
      },
    ),
    database
      .prepare(
        `DELETE FROM audit_template_families
         WHERE id IN (SELECT value FROM json_each(?))
           AND id IN (${discardedFamilies})
         RETURNING id`,
      )
      .bind(ids, cutoff),
  ]);
  const purged = deleted?.results ?? [];
  for (const { id } of purged)
    console.log({ event: "audit_form_purged", templateId: id });
  return purged.length;
}
