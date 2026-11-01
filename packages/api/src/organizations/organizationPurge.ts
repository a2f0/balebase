import { MaintenanceFailure } from "../jobs/maintenanceFailure";
import {
  maintenanceActor,
  type SystemActor,
  systemActivityRowsStatement,
} from "../shared/activity";
import type { Bindings } from "../types";

/** A deleted organization past its 30-day restoration window. */
const purgeable = `organization.id = ? AND organization.deletedAt IS NOT NULL
  AND julianday(organization.deletedAt) <= julianday(?)`;

/**
 * Each organization's cascades, durable file cleanup, and purge record commit
 * together. The record (`organization.purged`, platform activity that root
 * admins read) outlives the organization's own activity: it keeps who asked
 * for the deletion and how, from the organization's latest deletion event,
 * but not the organization's name.
 */
export async function purgeDeletedOrganizations(
  environment: Pick<Bindings, "DB">,
  runId: string,
  now = new Date(),
) {
  const actor = maintenanceActor("purgeDeletedOrganizations", runId);
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
      const [, result] = await environment.DB.batch<{ id: string }>([
        purgeRecord(environment.DB, actor, now, id, cutoff),
        environment.DB.prepare(
          `DELETE FROM organization WHERE ${purgeable} RETURNING id`,
        ).bind(id, cutoff),
      ]);
      if (result?.results.length) {
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

function purgeRecord(
  database: D1Database,
  actor: SystemActor,
  now: Date,
  organizationId: string,
  cutoff: string,
) {
  const fromDeletion = (value: string) => `(SELECT ${value}
    FROM activity_events AS event
    WHERE event.organization_id = organization.id
      AND event.action = 'organization.deletion_requested'
    ORDER BY event.id DESC LIMIT 1)`;
  return systemActivityRowsStatement(database, actor, now.toISOString(), {
    bindings: [organizationId, cutoff],
    sql: `SELECT NULL AS organization_id, 'organization' AS root_type,
                 organization.id AS root_id, organization.id AS root_label,
                 'organization' AS subject_type, organization.id AS subject_id,
                 'organization.purged' AS action,
                 json_object(
                   'deletedAt', organization.deletedAt,
                   'deletedBy', organization.deletedByUserId,
                   'deletedByName', ${fromDeletion("event.actor_name")},
                   'deletedByEmail', ${fromDeletion("event.actor_email")},
                   'via', ${fromDeletion("json_extract(event.details, '$.via')")}
                 ) AS details
          FROM organization WHERE ${purgeable}`,
  });
}
