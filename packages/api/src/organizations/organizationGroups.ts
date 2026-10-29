import {
  type OrganizationCapability,
  type OrganizationGroup,
  organizationGroupsRoutes,
} from "@balebase/validators/organizationGroups";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "../auth/apiEnv";
import { activityBatch, requestActor } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import {
  groupCreatedActivity,
  groupDeletedActivity,
  groupUpdatedActivity,
  type SqlFragment,
} from "./groupActivity";
import {
  countOrganizationOwners,
  listOrganizationMembers,
  requireManager,
  stillManages,
} from "./organizationMembers";

const invalidGroup =
  "A valid group name, members, and capabilities are required.";
const managerRequired = "Organization manager access required.";

interface GroupRow {
  created_at: string;
  id: string;
  name: string;
  updated_at: string | null;
}

interface CapabilityRow {
  capability: OrganizationCapability;
  team_id: string;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
}

interface GroupInput {
  capabilities: OrganizationCapability[];
  name: string;
  userIds: string[];
}

const organizationGroups = new Hono<ApiEnv>();

organizationGroups.get("/access", async (context) => {
  const organizationId = context.get("organizationId");
  const [capabilities, ownerCount] = await Promise.all([
    listUserCapabilities(
      context.env.DB,
      organizationId,
      context.get("authSession").user.id,
    ),
    countOrganizationOwners(context.env.DB, organizationId),
  ]);
  return respond(context, organizationGroupsRoutes.access, {
    capabilities,
    memberRole: context.get("organizationRole"),
    ownerCount,
  });
});

organizationGroups.get("/", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const [groups, capabilities, groupMembers, members] = await Promise.all([
    listGroups(context.env.DB, organizationId),
    listGroupCapabilities(context.env.DB, organizationId),
    listGroupMembers(context.env.DB, organizationId),
    listOrganizationMembers(context.env.DB, organizationId),
  ]);
  return respond(context, organizationGroupsRoutes.list, {
    groups: groups.map(
      (group): OrganizationGroup => ({
        capabilities: capabilities
          .filter(({ team_id: teamId }) => teamId === group.id)
          .map(({ capability }) => capability),
        createdAt: group.created_at,
        id: group.id,
        memberUserIds: groupMembers
          .filter(({ team_id: teamId }) => teamId === group.id)
          .map(({ user_id: userId }) => userId),
        name: group.name,
        updatedAt: group.updated_at,
      }),
    ),
    members,
  });
});

organizationGroups.post("/", requireManager(), async (context) => {
  const input = await readBody(
    context,
    organizationGroupsRoutes.create,
    invalidGroup,
  );
  if (input instanceof Response) return input;
  const organizationId = context.get("organizationId");
  if (
    !(await membersBelongToOrganization(
      context.env.DB,
      organizationId,
      input.userIds,
    ))
  ) {
    return context.json(
      { error: "Every group member must belong to this organization." },
      400,
    );
  }
  if (await groupNameExists(context.env.DB, organizationId, input.name)) {
    return context.json(
      { error: "A group with that name already exists." },
      409,
    );
  }
  const groupId = crypto.randomUUID();
  if (!(await createGroup(context, groupId, input))) {
    return context.json({ error: managerRequired }, 403);
  }
  return respond(
    context,
    organizationGroupsRoutes.create,
    { id: groupId },
    201,
  );
});

organizationGroups.patch("/:id", requireManager(), async (context) => {
  const groupId = context.req.param("id") ?? "";
  const input = await readBody(
    context,
    organizationGroupsRoutes.update,
    invalidGroup,
  );
  if (input instanceof Response) return input;
  const organizationId = context.get("organizationId");
  if (!(await groupExists(context.env.DB, organizationId, groupId))) {
    return context.json({ error: "Group not found." }, 404);
  }
  if (
    !(await membersBelongToOrganization(
      context.env.DB,
      organizationId,
      input.userIds,
    ))
  ) {
    return context.json(
      { error: "Every group member must belong to this organization." },
      400,
    );
  }
  if (
    await groupNameExists(context.env.DB, organizationId, input.name, groupId)
  ) {
    return context.json(
      { error: "A group with that name already exists." },
      409,
    );
  }
  if (!(await updateGroup(context, groupId, input))) {
    return groupWriteRefused(context, groupId);
  }
  return respond(context, organizationGroupsRoutes.update, { id: groupId });
});

organizationGroups.delete("/:id", requireManager(), async (context) => {
  const groupId = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (
    !groupId ||
    !(await groupExists(context.env.DB, organizationId, groupId))
  ) {
    return context.json({ error: "Group not found." }, 404);
  }
  if (!(await deleteGroup(context, groupId))) {
    return groupWriteRefused(context, groupId);
  }
  return context.body(null, 204);
});

export function requireCapability(capability: OrganizationCapability) {
  return createMiddleware<ApiEnv>(async (context, next) => {
    const hasAccess = await userHasCapability(
      context.env.DB,
      context.get("organizationId"),
      context.get("authSession").user.id,
      capability,
    );
    if (!hasAccess) {
      return context.json(
        { error: `${capabilityLabel(capability)} group membership required.` },
        403,
      );
    }
    return next();
  });
}

async function listUserCapabilities(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  const result = await database
    .prepare(
      `SELECT DISTINCT access.capability
       FROM organization_group_capability AS access
       JOIN "team" ON "team"."id" = access.team_id
       JOIN "teamMember" ON "teamMember"."teamId" = "team"."id"
       WHERE access.organization_id = ? AND "team"."organizationId" = ?
         AND "teamMember"."userId" = ?`,
    )
    .bind(organizationId, organizationId, userId)
    .all<{ capability: OrganizationCapability }>();
  return result.results.map(({ capability }) => capability);
}

export async function userHasCapability(
  database: D1Database,
  organizationId: string,
  userId: string,
  capability: OrganizationCapability,
) {
  return Boolean(
    await database
      .prepare(
        `SELECT 1
         FROM organization_group_capability AS access
         JOIN "team" ON "team"."id" = access.team_id
         JOIN "teamMember" ON "teamMember"."teamId" = "team"."id"
         WHERE access.organization_id = ? AND access.capability = ?
           AND "team"."organizationId" = ? AND "teamMember"."userId" = ?
         LIMIT 1`,
      )
      .bind(organizationId, capability, organizationId, userId)
      .first(),
  );
}

async function listGroups(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT "id", "name", "createdAt" AS created_at,
              "updatedAt" AS updated_at
       FROM "team" WHERE "organizationId" = ? ORDER BY "name" ASC`,
    )
    .bind(organizationId)
    .all<GroupRow>();
  return result.results;
}

async function listGroupCapabilities(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT team_id, capability FROM organization_group_capability
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .all<CapabilityRow>();
  return result.results;
}

async function listGroupMembers(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT "teamMember"."teamId" AS team_id,
              "teamMember"."userId" AS user_id
       FROM "teamMember"
       JOIN "team" ON "team"."id" = "teamMember"."teamId"
       WHERE "team"."organizationId" = ?`,
    )
    .bind(organizationId)
    .all<TeamMemberRow>();
  return result.results;
}

async function membersBelongToOrganization(
  database: D1Database,
  organizationId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return true;
  const placeholders = userIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT "userId" FROM "member"
       WHERE "organizationId" = ? AND "userId" IN (${placeholders})`,
    )
    .bind(organizationId, ...userIds)
    .all<{ userId: string }>();
  return result.results.length === userIds.length;
}

async function groupNameExists(
  database: D1Database,
  organizationId: string,
  name: string,
  excludedId?: string,
) {
  const query = `SELECT 1 FROM "team"
    WHERE "organizationId" = ? AND lower("name") = lower(?)
    ${excludedId ? 'AND "id" <> ?' : ""} LIMIT 1`;
  const statement = database.prepare(query);
  return Boolean(
    excludedId
      ? await statement.bind(organizationId, name, excludedId).first()
      : await statement.bind(organizationId, name).first(),
  );
}

async function groupExists(
  database: D1Database,
  organizationId: string,
  groupId: string,
) {
  return Boolean(
    await database
      .prepare('SELECT 1 FROM "team" WHERE "id" = ? AND "organizationId" = ?')
      .bind(groupId, organizationId)
      .first(),
  );
}

/** A write that changed nothing: the group is gone or the actor demoted. */
async function groupWriteRefused(context: Context<ApiEnv>, groupId: string) {
  return (await groupExists(
    context.env.DB,
    context.get("organizationId"),
    groupId,
  ))
    ? context.json({ error: managerRequired }, 403)
    : context.json({ error: "Group not found." }, 404);
}

/** The database, the event's identity, and the acting manager's guard. */
function groupWrite(context: Context<ApiEnv>, groupId: string) {
  const actor = requestActor(context);
  const organizationId = context.get("organizationId");
  return {
    actor,
    database: context.env.DB,
    event: {
      actorId: actor.userId,
      groupId,
      occurredAt: new Date().toISOString(),
      organizationId,
    },
    guard: stillManages(organizationId, actor.userId),
    organizationId,
  };
}

/** Whether the group belongs to the organization and the actor manages it. */
function writableGroup(write: ReturnType<typeof groupWrite>): SqlFragment {
  return {
    bindings: [
      write.event.groupId,
      write.organizationId,
      ...write.guard.bindings,
    ],
    sql: `EXISTS (SELECT 1 FROM "team" WHERE "id" = ? AND "organizationId" = ?)
          AND ${write.guard.sql}`,
  };
}

async function createGroup(
  context: Context<ApiEnv>,
  groupId: string,
  input: GroupInput,
) {
  const write = groupWrite(context, groupId);
  const { database, event, guard, organizationId } = write;
  const [created] = await activityBatch(database, write.actor.apiKey, [
    database
      .prepare(
        `INSERT INTO "team"
         ("id", "name", "organizationId", "memberCount", "createdAt", "updatedAt")
         SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      )
      .bind(
        groupId,
        input.name,
        organizationId,
        input.userIds.length,
        event.occurredAt,
        event.occurredAt,
        ...guard.bindings,
      ),
    ...grantStatements(write, input),
    groupCreatedActivity(database, event),
  ]);
  return Boolean(created?.meta.changes);
}

async function updateGroup(
  context: Context<ApiEnv>,
  groupId: string,
  input: GroupInput,
) {
  const write = groupWrite(context, groupId);
  const { database, event, guard, organizationId } = write;
  const writable = writableGroup(write);
  const [, updated] = await activityBatch(database, write.actor.apiKey, [
    groupUpdatedActivity(database, event, input, guard),
    database
      .prepare(
        `UPDATE "team" SET "name" = ?, "memberCount" = ?, "updatedAt" = ?
         WHERE "id" = ? AND "organizationId" = ? AND ${guard.sql}`,
      )
      .bind(
        input.name,
        input.userIds.length,
        event.occurredAt,
        groupId,
        organizationId,
        ...guard.bindings,
      ),
    // Unchanged members and capabilities keep their rows.
    database
      .prepare(
        `DELETE FROM organization_group_capability
         WHERE organization_id = ? AND team_id = ?
           AND capability NOT IN (SELECT value FROM json_each(?))
           AND ${writable.sql}`,
      )
      .bind(
        organizationId,
        groupId,
        JSON.stringify(input.capabilities),
        ...writable.bindings,
      ),
    database
      .prepare(
        `DELETE FROM "teamMember"
         WHERE "teamId" = ? AND "userId" NOT IN (SELECT value FROM json_each(?))
           AND ${writable.sql}`,
      )
      .bind(groupId, JSON.stringify(input.userIds), ...writable.bindings),
    ...grantStatements(write, input),
  ]);
  return Boolean(updated?.meta.changes);
}

async function deleteGroup(context: Context<ApiEnv>, groupId: string) {
  const write = groupWrite(context, groupId);
  const { database, event, guard, organizationId } = write;
  const writable = writableGroup(write);
  const results = await activityBatch(database, write.actor.apiKey, [
    groupDeletedActivity(database, event, guard),
    database
      .prepare(
        `DELETE FROM organization_group_capability
         WHERE organization_id = ? AND team_id = ? AND ${writable.sql}`,
      )
      .bind(organizationId, groupId, ...writable.bindings),
    database
      .prepare(
        `DELETE FROM "teamMember" WHERE "teamId" = ? AND ${writable.sql}`,
      )
      .bind(groupId, ...writable.bindings),
    database
      .prepare(
        `DELETE FROM "team"
         WHERE "id" = ? AND "organizationId" = ? AND ${guard.sql}`,
      )
      .bind(groupId, organizationId, ...guard.bindings),
  ]);
  return Boolean(results.at(-1)?.meta.changes);
}

/** Adds the capabilities and current members the group does not have yet. */
function grantStatements(
  write: ReturnType<typeof groupWrite>,
  input: GroupInput,
) {
  const { database, event, organizationId } = write;
  const writable = writableGroup(write);
  return [
    database
      .prepare(
        `INSERT INTO organization_group_capability
         (organization_id, team_id, capability)
         SELECT ?, ?, input.value FROM json_each(?) AS input
         WHERE NOT EXISTS (
           SELECT 1 FROM organization_group_capability
           WHERE team_id = ? AND capability = input.value
         ) AND ${writable.sql}`,
      )
      .bind(
        organizationId,
        event.groupId,
        JSON.stringify(input.capabilities),
        event.groupId,
        ...writable.bindings,
      ),
    ...input.userIds.map((userId) =>
      database
        .prepare(
          `INSERT INTO "teamMember"
           ("id", "teamId", "userId", "membershipKey", "createdAt")
           SELECT ?, ?, ?, NULL, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM "teamMember" WHERE "teamId" = ? AND "userId" = ?
           )
           AND EXISTS (
             SELECT 1 FROM member WHERE organizationId = ? AND userId = ?
           )
           AND ${writable.sql}`,
        )
        .bind(
          crypto.randomUUID(),
          event.groupId,
          userId,
          event.occurredAt,
          event.groupId,
          userId,
          organizationId,
          userId,
          ...writable.bindings,
        ),
    ),
  ];
}

function capabilityLabel(capability: OrganizationCapability) {
  return capability[0]?.toUpperCase() + capability.slice(1);
}

export { organizationGroups };
