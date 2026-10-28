import {
  type OrganizationCapability,
  OrganizationCapabilitySchema,
  type OrganizationGroup,
  organizationGroupsRoutes,
} from "@balebase/validators/organizationGroups";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "./authMiddleware";
import {
  countOrganizationOwners,
  listOrganizationMembers,
  requireManager,
} from "./organizationMembers";
import { respond } from "./respond";

const supportedCapabilities = OrganizationCapabilitySchema.options;

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

interface RawGroupInput {
  capabilities?: unknown;
  name?: unknown;
  userIds?: unknown;
}

type OrganizationContext = Context<ApiEnv>;

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
  const input = await groupInput(context);
  if (!input) return invalidGroup(context);
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
  await writeGroup(context.env.DB, organizationId, groupId, input, true);
  return respond(
    context,
    organizationGroupsRoutes.create,
    { id: groupId },
    201,
  );
});

organizationGroups.patch("/:id", requireManager(), async (context) => {
  const groupId = context.req.param("id");
  const input = await groupInput(context);
  if (!groupId || !input) return invalidGroup(context);
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
  await writeGroup(context.env.DB, organizationId, groupId, input, false);
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
  await context.env.DB.batch([
    context.env.DB.prepare(
      `DELETE FROM organization_group_capability
         WHERE organization_id = ? AND team_id = ?`,
    ).bind(organizationId, groupId),
    context.env.DB.prepare('DELETE FROM "teamMember" WHERE "teamId" = ?').bind(
      groupId,
    ),
    context.env.DB.prepare(
      'DELETE FROM "team" WHERE "id" = ? AND "organizationId" = ?',
    ).bind(groupId, organizationId),
  ]);
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

async function groupInput(context: OrganizationContext) {
  const value: unknown = await context.req.json().catch(() => null);
  if (!isGroupInputRecord(value) || typeof value.name !== "string") return null;
  const name = value.name.trim();
  const capabilities = uniqueStrings(value.capabilities);
  const userIds = uniqueStrings(value.userIds);
  if (
    !name ||
    name.length > 100 ||
    !capabilities ||
    !userIds ||
    userIds.length > 100 ||
    capabilities.some((item) => !isCapability(item))
  ) {
    return null;
  }
  return { capabilities, name, userIds } as GroupInput;
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return [
    ...new Set(value.map((item) => (item as string).trim()).filter(Boolean)),
  ];
}

function isCapability(value: string): value is OrganizationCapability {
  return (supportedCapabilities as readonly string[]).includes(value);
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

async function writeGroup(
  database: D1Database,
  organizationId: string,
  groupId: string,
  input: GroupInput,
  create: boolean,
) {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = create
    ? [
        database
          .prepare(
            `INSERT INTO "team"
             ("id", "name", "organizationId", "memberCount", "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            groupId,
            input.name,
            organizationId,
            input.userIds.length,
            now,
            now,
          ),
      ]
    : [
        database
          .prepare(
            `UPDATE "team" SET "name" = ?, "memberCount" = ?, "updatedAt" = ?
             WHERE "id" = ? AND "organizationId" = ?`,
          )
          .bind(input.name, input.userIds.length, now, groupId, organizationId),
        database
          .prepare(
            `DELETE FROM organization_group_capability
             WHERE organization_id = ? AND team_id = ?`,
          )
          .bind(organizationId, groupId),
        database
          .prepare('DELETE FROM "teamMember" WHERE "teamId" = ?')
          .bind(groupId),
      ];
  statements.push(
    ...input.capabilities.map((capability) =>
      database
        .prepare(
          `INSERT INTO organization_group_capability
           (organization_id, team_id, capability) VALUES (?, ?, ?)`,
        )
        .bind(organizationId, groupId, capability),
    ),
    ...input.userIds.map((userId) =>
      database
        .prepare(
          `INSERT INTO "teamMember"
           ("id", "teamId", "userId", "membershipKey", "createdAt")
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), groupId, userId, now),
    ),
  );
  await database.batch(statements);
}

function invalidGroup(context: OrganizationContext) {
  return context.json(
    { error: "A valid group name, members, and capabilities are required." },
    400,
  );
}

function capabilityLabel(capability: OrganizationCapability) {
  return capability[0]?.toUpperCase() + capability.slice(1);
}

function isGroupInputRecord(value: unknown): value is RawGroupInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { organizationGroups };
