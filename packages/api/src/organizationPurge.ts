import type { Bindings } from "./types";

/** Eligibility, cascading deletes, and durable file cleanup commit together. */
export async function purgeDeletedOrganizations(
  environment: Pick<Bindings, "DB">,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  // A restore committed before this statement wins. Storage is deleted later
  // from tombstones, so there is no R2 deletion racing a restored organization.
  const { results } = await environment.DB.prepare(
    `DELETE FROM organization WHERE id IN (
       SELECT id FROM organization
       WHERE deletedAt IS NOT NULL AND julianday(deletedAt) <= julianday(?)
       ORDER BY julianday(deletedAt), id LIMIT 25
     ) RETURNING id`,
  )
    .bind(cutoff)
    .all<{ id: string }>();
  return { purged: results.length };
}
