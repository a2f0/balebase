import { discardedTemplateRetentionDays } from "@balebase/validators/rules";
import type { Bindings } from "../types";

const batchSize = 100;

/**
 * Permanently deletes up to 100 global forms discarded at least 30 days ago,
 * with their versions and history. Audits started from them keep their
 * snapshots; projects lose them. Eligibility is checked in the same statement
 * as the deletion, so a restore committed first keeps the form.
 */
export async function purgeDiscardedAuditForms(
  environment: Pick<Bindings, "DB">,
  now = new Date(),
) {
  const cutoff = new Date(
    now.getTime() - discardedTemplateRetentionDays * 86400000,
  ).toISOString();
  const { results } = await environment.DB.prepare(
    `DELETE FROM audit_template_families
     WHERE id IN (
       SELECT family.id
       FROM audit_template_families AS family
       JOIN audit_template_versions AS version
         ON version.template_id = family.id
        AND version.version = family.current_version
       WHERE family.scope = 'global' AND version.status = 'discarded'
         AND julianday(version.created_at) <= julianday(?)
       ORDER BY julianday(version.created_at), family.id
       LIMIT ?
     )
     RETURNING id`,
  )
    .bind(cutoff, batchSize)
    .all<{ id: string }>();
  for (const { id } of results)
    console.log({ event: "audit_form_purged", templateId: id });
  return results.length;
}
