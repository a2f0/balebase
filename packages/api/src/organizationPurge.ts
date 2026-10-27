import { MaintenanceFailure } from "./maintenanceFailure";
import type { Bindings } from "./types";

/** Each organization's cascades and durable file cleanup commit together. */
export async function purgeDeletedOrganizations(
  environment: Pick<Bindings, "DB">,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const { results } = await environment.DB.prepare(
    `SELECT id FROM organization
     WHERE deletedAt IS NOT NULL AND julianday(deletedAt) <= julianday(?)
     ORDER BY purgeAttemptedAt IS NOT NULL, purgeAttemptedAt, julianday(deletedAt), id
     LIMIT 25`,
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const output = { purged: 0, skipped: 0, failed: 0 };
  let firstFailure: unknown;
  for (const { id } of results) {
    try {
      await environment.DB.prepare(
        "UPDATE organization SET purgeAttemptedAt = ? WHERE id = ?",
      )
        .bind(now.toISOString(), id)
        .run();
      // Recheck eligibility atomically with this organization's cascades. A
      // restore committed first wins, and no R2 writes precede this decision.
      const deleted = await environment.DB.prepare(
        `DELETE FROM organization WHERE id = ?
         AND deletedAt IS NOT NULL AND julianday(deletedAt) <= julianday(?)
         RETURNING id`,
      )
        .bind(id, cutoff)
        .first<{ id: string }>();
      if (deleted) {
        output.purged++;
        console.log({ event: "organization_purged", organizationId: id });
      } else {
        output.skipped++;
      }
    } catch (cause) {
      output.failed++;
      firstFailure ??= cause;
      console.error(
        { event: "organization_purge_failed", organizationId: id },
        cause,
      );
    }
  }
  if (output.failed) throw new MaintenanceFailure(output, firstFailure);
  return output;
}
