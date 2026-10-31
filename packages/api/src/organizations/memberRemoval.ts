/**
 * Removing a member, or a member leaving, in one transaction with its history.
 * Better Auth would delete the membership and each group grant in separate
 * writes that carry no actor, so the request's removal runs here instead:
 * the events read the stored membership, groups, equipment and API keys
 * before the deletes, and every statement holds only while the removal is
 * still allowed. Nothing in this module may import a route module, because
 * auth.ts imports it.
 */

export type MemberRemovalReason = "member_left" | "member_removed";

interface MemberRemoval {
  actorId: string;
  memberId: string;
  reason: MemberRemovalReason;
}

/** Whether the removal took effect, or why it did not. */
export type MemberRemovalResult = "forbidden" | "not_found" | "removed";

const roles = (column: string) => `(',' || replace(${column}, ' ', '') || ',')`;

/**
 * Holds while the membership exists and the removal is still allowed: a
 * manager removing someone must still own or administer the organization, a
 * person leaving must still be that member, and the last owner never goes.
 */
function removalAllowed(removal: MemberRemoval) {
  const actorCondition =
    removal.reason === "member_left"
      ? "removed.userId = ?"
      : `EXISTS (
          SELECT 1 FROM member AS acting
          WHERE acting.organizationId = removed.organizationId
            AND acting.userId = ?
            AND (instr(${roles("acting.role")}, ',owner,') > 0
                 OR instr(${roles("acting.role")}, ',admin,') > 0)
        )`;
  return {
    bindings: [removal.memberId, removal.actorId],
    sql: `EXISTS (
      SELECT 1 FROM member AS removed
      WHERE removed.id = ?
        AND ${actorCondition}
        AND (instr(${roles("removed.role")}, ',owner,') = 0
             OR EXISTS (
               SELECT 1 FROM member AS other
               WHERE other.organizationId = removed.organizationId
                 AND other.id <> removed.id
                 AND instr(${roles("other.role")}, ',owner,') > 0
             ))
    )`,
  };
}

const insertEvent = `INSERT INTO activity_events (
  organization_id, root_type, root_id, root_label, subject_type, subject_id,
  action, actor_user_id, actor_name, actor_email, occurred_at, details
)`;

/** The membership's end, with the role and API keys it held. */
function membershipEvent(
  database: D1Database,
  removal: MemberRemoval,
  occurredAt: string,
) {
  const allowed = removalAllowed(removal);
  return database
    .prepare(
      `${insertEvent}
       SELECT member.organizationId, 'organization_member', member.id,
              person.name, 'organization_member', member.id, ?,
              actor.id, actor.name, actor.email, ?,
              json_object(
                'role', member.role, 'userId', person.id,
                'userName', person.name, 'userEmail', person.email,
                -- Keys stop working once their creator is no longer a member.
                'apiKeys', json((
                  SELECT json_group_array(json_object('id', id, 'name', name))
                  FROM (
                    SELECT id, name FROM organization_api_keys
                    WHERE organization_id = member.organizationId
                      AND created_by = member.userId AND revoked_at IS NULL
                    ORDER BY created_at, id
                  )
                )))
       FROM member
       JOIN user AS person ON person.id = member.userId
       JOIN user AS actor ON actor.id = ?
       WHERE member.id = ? AND ${allowed.sql}`,
    )
    .bind(
      removal.reason === "member_left"
        ? "organization.member_left"
        : "organization.member_removed",
      occurredAt,
      removal.actorId,
      removal.memberId,
      ...allowed.bindings,
    );
}

/** Each group the person loses, as a group update managers can read. */
function groupEvents(
  database: D1Database,
  removal: MemberRemoval,
  occurredAt: string,
) {
  const allowed = removalAllowed(removal);
  return database
    .prepare(
      `${insertEvent}
       SELECT "team"."organizationId", 'organization_group', "team"."id",
              "team"."name", 'organization_group', "team"."id",
              'organization.group_updated', actor.id, actor.name, actor.email,
              ?,
              json_object(
                'name', "team"."name", 'renamedFrom', NULL,
                'addedMembers', json('[]'),
                'removedMembers', json_array(json_object(
                  'userId', person.id, 'name', person.name,
                  'email', person.email)),
                'addedCapabilities', json('[]'),
                'removedCapabilities', json('[]'),
                'capabilities', json((
                  SELECT json_group_array(capability) FROM (
                    SELECT capability FROM organization_group_capability
                    WHERE team_id = "team"."id" ORDER BY capability
                  )
                )),
                'reason', ?)
       FROM member
       JOIN "team" ON "team"."organizationId" = member.organizationId
       JOIN "teamMember" ON "teamMember"."teamId" = "team"."id"
         AND "teamMember"."userId" = member.userId
       JOIN user AS person ON person.id = member.userId
       JOIN user AS actor ON actor.id = ?
       WHERE member.id = ? AND ${allowed.sql}
       ORDER BY "team"."name", "team"."id"`,
    )
    .bind(
      occurredAt,
      removal.reason,
      removal.actorId,
      removal.memberId,
      ...allowed.bindings,
    );
}

/**
 * Equipment returns to unassigned when its holder leaves (the 0037 trigger
 * clears it on the member delete). Record each item's change first.
 */
function equipmentEvents(
  database: D1Database,
  removal: MemberRemoval,
  occurredAt: string,
) {
  const allowed = removalAllowed(removal);
  return database
    .prepare(
      `${insertEvent}
       SELECT equipment.organization_id, 'equipment', equipment.id,
              equipment.make || ' ' || equipment.model, 'equipment',
              equipment.id, 'equipment.assigned',
              actor.id, actor.name, actor.email, ?,
              json_object('before', person.id, 'after', NULL,
                          'beforeName', person.name,
                          'beforeEmail', person.email,
                          'afterName', NULL, 'afterEmail', NULL,
                          'reason', ?)
       FROM member
       JOIN equipment ON equipment.organization_id = member.organizationId
         AND equipment.assigned_user_id = member.userId
       JOIN user AS person ON person.id = member.userId
       JOIN user AS actor ON actor.id = ?
       WHERE member.id = ? AND ${allowed.sql}
       ORDER BY equipment.created_at, equipment.id`,
    )
    .bind(
      occurredAt,
      removal.reason,
      removal.actorId,
      removal.memberId,
      ...allowed.bindings,
    );
}

/** Releases the person's group seats and grants, as Better Auth would. */
function groupDeletes(database: D1Database, removal: MemberRemoval) {
  const allowed = removalAllowed(removal);
  const groups = `SELECT "teamMember"."teamId" FROM "teamMember"
    JOIN "team" ON "team"."id" = "teamMember"."teamId"
    JOIN member ON member.organizationId = "team"."organizationId"
      AND member.userId = "teamMember"."userId"
    WHERE member.id = ?`;
  return [
    database
      .prepare(
        `UPDATE "team" SET "memberCount" = MAX("memberCount" - 1, 0)
         WHERE "id" IN (${groups}) AND ${allowed.sql}`,
      )
      .bind(removal.memberId, ...allowed.bindings),
    database
      .prepare(
        `DELETE FROM "teamMember"
         WHERE "id" IN (
           SELECT "teamMember"."id" FROM "teamMember"
           JOIN "team" ON "team"."id" = "teamMember"."teamId"
           JOIN member ON member.organizationId = "team"."organizationId"
             AND member.userId = "teamMember"."userId"
           WHERE member.id = ?
         ) AND ${allowed.sql}`,
      )
      .bind(removal.memberId, ...allowed.bindings),
  ];
}

export async function removeMemberWithActivity(
  database: D1Database,
  removal: MemberRemoval,
): Promise<MemberRemovalResult> {
  const occurredAt = new Date().toISOString();
  const allowed = removalAllowed(removal);
  const results = await database.batch([
    membershipEvent(database, removal, occurredAt),
    groupEvents(database, removal, occurredAt),
    equipmentEvents(database, removal, occurredAt),
    ...groupDeletes(database, removal),
    database
      .prepare(`DELETE FROM member WHERE id = ? AND ${allowed.sql}`)
      .bind(removal.memberId, ...allowed.bindings),
  ]);
  if (results.at(-1)?.meta.changes) return "removed";
  const member = await database
    .prepare("SELECT 1 FROM member WHERE id = ?")
    .bind(removal.memberId)
    .first();
  return member ? "forbidden" : "not_found";
}
