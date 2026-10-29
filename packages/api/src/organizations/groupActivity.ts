import type { OrganizationCapability } from "@balebase/validators/organizationGroups";

/**
 * Group history. Each statement belongs in the batch that changes the group,
 * reads the group's state inside that transaction, and records an event only
 * while its condition holds. The activity feed shows group events only to
 * organization managers.
 */

/** A SQL fragment and its bindings. */
export interface SqlFragment {
  bindings: (string | number)[];
  sql: string;
}

const always: SqlFragment = { bindings: [], sql: "1" };
const nothing: SqlFragment = { bindings: [], sql: "" };

interface GroupEvent {
  actorId: string;
  groupId: string;
  occurredAt: string;
  organizationId: string;
}

/** People selected by `source` (id, name, email) as a JSON array. */
function peopleJson(source: string) {
  return `json((
    SELECT json_group_array(json_object('userId', id, 'name', name, 'email', email))
    FROM (${source})
  ))`;
}

/** Capabilities selected by `source` as a JSON array. */
function capabilitiesJson(source: string) {
  return `json((SELECT json_group_array(capability) FROM (${source})))`;
}

function insertGroupEvent(
  database: D1Database,
  action: string,
  event: GroupEvent,
  parts: {
    condition: SqlFragment;
    details: SqlFragment;
    join?: SqlFragment;
    label: SqlFragment;
  },
) {
  const join = parts.join ?? nothing;
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type, subject_id,
         action, actor_user_id, actor_name, actor_email, occurred_at, details
       )
       SELECT "team"."organizationId", 'organization_group', "team"."id",
              ${parts.label.sql}, 'organization_group', "team"."id", ?,
              actor.id, actor.name, actor.email, ?, ${parts.details.sql}
       FROM "team" JOIN user AS actor ON actor.id = ? ${join.sql}
       WHERE "team"."id" = ? AND "team"."organizationId" = ?
         AND (${parts.condition.sql})`,
    )
    .bind(
      ...parts.label.bindings,
      action,
      event.occurredAt,
      ...parts.details.bindings,
      event.actorId,
      ...join.bindings,
      event.groupId,
      event.organizationId,
      ...parts.condition.bindings,
    );
}

/** The group's stored name, members and capabilities. */
function snapshot(groupId: string): SqlFragment {
  return {
    bindings: [groupId, groupId],
    sql: `json_object(
      'name', "team"."name",
      'members', ${peopleJson(`
        SELECT user.id, user.name, user.email
        FROM "teamMember" JOIN user ON user.id = "teamMember"."userId"
        WHERE "teamMember"."teamId" = ?
        ORDER BY user.name, user.id`)},
      'capabilities', ${capabilitiesJson(`
        SELECT capability FROM organization_group_capability
        WHERE team_id = ? ORDER BY capability`)})`,
  };
}

const storedName: SqlFragment = { bindings: [], sql: '"team"."name"' };

/** Records a new group's members and capabilities. Run it after the inserts. */
export function groupCreatedActivity(database: D1Database, event: GroupEvent) {
  return insertGroupEvent(database, "organization.group_created", event, {
    condition: always,
    details: snapshot(event.groupId),
    label: storedName,
  });
}

/** Records what a group held. Run it before the deletes. */
export function groupDeletedActivity(
  database: D1Database,
  event: GroupEvent,
  condition: SqlFragment,
) {
  return insertGroupEvent(database, "organization.group_deleted", event, {
    condition,
    details: snapshot(event.groupId),
    label: storedName,
  });
}

/**
 * Records the members and capabilities an update grants and revokes, and a
 * rename, against the group's stored state. Run it before the update's
 * writes. An update that changes nothing records nothing.
 */
export function groupUpdatedActivity(
  database: D1Database,
  event: GroupEvent,
  input: {
    capabilities: OrganizationCapability[];
    name: string;
    userIds: string[];
  },
  condition: SqlFragment,
) {
  const userIds = JSON.stringify(input.userIds);
  const capabilities = JSON.stringify(input.capabilities);
  const { groupId, organizationId } = event;
  return insertGroupEvent(database, "organization.group_updated", event, {
    condition: {
      bindings: [input.name, ...condition.bindings],
      sql: `("team"."name" <> ? OR delta.added_members <> '[]'
             OR delta.removed_members <> '[]'
             OR delta.added_capabilities <> '[]'
             OR delta.removed_capabilities <> '[]')
            AND (${condition.sql})`,
    },
    details: {
      bindings: [input.name, input.name],
      sql: `json_object(
        'name', ?,
        'renamedFrom', CASE WHEN "team"."name" <> ? THEN "team"."name" END,
        'addedMembers', json(delta.added_members),
        'removedMembers', json(delta.removed_members),
        'addedCapabilities', json(delta.added_capabilities),
        'removedCapabilities', json(delta.removed_capabilities))`,
    },
    join: {
      bindings: [
        userIds,
        organizationId,
        groupId,
        groupId,
        userIds,
        capabilities,
        groupId,
        groupId,
        capabilities,
      ],
      sql: `JOIN (
        SELECT
          ${peopleJson(`
            SELECT user.id, user.name, user.email
            FROM json_each(?) AS input JOIN user ON user.id = input.value
            WHERE EXISTS (
              SELECT 1 FROM member
              WHERE member.organizationId = ? AND member.userId = input.value
            )
            AND NOT EXISTS (
              SELECT 1 FROM "teamMember"
              WHERE "teamMember"."teamId" = ?
                AND "teamMember"."userId" = input.value
            )
            ORDER BY user.name, user.id`)} AS added_members,
          ${peopleJson(`
            SELECT user.id, user.name, user.email
            FROM "teamMember" JOIN user ON user.id = "teamMember"."userId"
            WHERE "teamMember"."teamId" = ?
              AND "teamMember"."userId" NOT IN (SELECT value FROM json_each(?))
            ORDER BY user.name, user.id`)} AS removed_members,
          ${capabilitiesJson(`
            SELECT input.value AS capability FROM json_each(?) AS input
            WHERE input.value NOT IN (
              SELECT capability FROM organization_group_capability
              WHERE team_id = ?
            )
            ORDER BY capability`)} AS added_capabilities,
          ${capabilitiesJson(`
            SELECT capability FROM organization_group_capability
            WHERE team_id = ?
              AND capability NOT IN (SELECT value FROM json_each(?))
            ORDER BY capability`)} AS removed_capabilities
      ) AS delta`,
    },
    label: { bindings: [input.name], sql: "?" },
  });
}
