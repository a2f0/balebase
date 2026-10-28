import type { Database, SQLQueryBindings } from "bun:sqlite";

const seededAt = "2026-08-18T12:00:00.000Z";

export interface SeedUser {
  id: string;
  name?: string;
  email?: string;
  /** The platform role; "admin" opens the admin console. */
  role?: string;
  emailVerified?: boolean;
  createdAt?: string;
  defaultOrganizationId?: string | null;
}

export function seedUser(database: Database, user: SeedUser) {
  const createdAt = user.createdAt ?? seededAt;
  // Migration tests seed users before 0004 adds the default organization.
  const defaultOrganization =
    user.defaultOrganizationId === undefined
      ? {}
      : { defaultOrganizationId: user.defaultOrganizationId };
  const row = {
    banned: 0,
    createdAt,
    email: user.email ?? `${user.id}@example.com`,
    emailVerified: user.emailVerified ?? true,
    id: user.id,
    name: user.name ?? user.id,
    role: user.role ?? "user",
    updatedAt: createdAt,
    ...defaultOrganization,
  };
  insertRow(database, "user", row);
  return user.id;
}

export function seedOrganization(
  database: Database,
  organization: {
    id: string;
    name?: string;
    slug?: string;
    createdAt?: string;
  },
) {
  database
    .query(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      organization.id,
      organization.name ?? organization.id,
      organization.slug ?? organization.id,
      organization.createdAt ?? seededAt,
    );
  return organization.id;
}

export function seedMember(
  database: Database,
  member: {
    organizationId: string;
    userId: string;
    id?: string;
    role?: string;
    createdAt?: string;
  },
) {
  const id = member.id ?? `member_${member.userId}_${member.organizationId}`;
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      member.organizationId,
      member.userId,
      member.role ?? "member",
      member.createdAt ?? seededAt,
    );
  return id;
}

/** A group, with its members and capabilities, in `organizationId`. */
export function seedGroup(
  database: Database,
  group: {
    organizationId: string;
    name?: string;
    id?: string;
    capabilities?: string[];
    userIds?: string[];
  },
) {
  const name = group.name ?? "Finance";
  const id = group.id ?? `team_${name.toLowerCase()}_${group.organizationId}`;
  const userIds = group.userIds ?? [];
  database
    .query(
      `INSERT INTO team
       (id, name, organizationId, memberCount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, group.organizationId, userIds.length, seededAt, seededAt);
  for (const userId of userIds)
    database
      .query(
        `INSERT INTO teamMember (id, teamId, userId, membershipKey, createdAt)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(`team_member_${id}_${userId}`, id, userId, seededAt);
  for (const capability of group.capabilities ?? ["finance"])
    database
      .query(
        `INSERT INTO organization_group_capability
         (organization_id, team_id, capability) VALUES (?, ?, ?)`,
      )
      .run(group.organizationId, id, capability);
  return id;
}

/**
 * A user who owns their default organization, as sign-up leaves them: the
 * organization `org_<id>` with the owner membership `member_<id>` and its
 * Finance group.
 */
export function seedAccount(
  database: Database,
  user: SeedUser & { organizationName?: string },
) {
  const organizationId = `org_${user.id}`;
  const createdAt = user.createdAt ?? seededAt;
  seedOrganization(database, {
    createdAt,
    id: organizationId,
    name: user.organizationName ?? `${user.name ?? user.id}'s Organization`,
    slug: `personal-${user.id.toLowerCase()}`,
  });
  seedUser(database, { ...user, defaultOrganizationId: organizationId });
  const memberId = seedMember(database, {
    createdAt,
    id: `member_${user.id}`,
    organizationId,
    role: "owner",
    userId: user.id,
  });
  seedGroup(database, { organizationId, userIds: [user.id] });
  return { memberId, organizationId, userId: user.id };
}

/** Inserts an `organization_billing` row with only the given columns set. */
export function insertBilling(
  database: Database,
  organizationId: string,
  columns: Record<string, SQLQueryBindings> = {},
) {
  insertRow(database, "organization_billing", {
    updated_at: new Date().toISOString(),
    ...columns,
    organization_id: organizationId,
  });
}

function insertRow(
  database: Database,
  table: string,
  row: Record<string, SQLQueryBindings>,
) {
  const names = Object.keys(row);
  database
    .query(
      `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
       VALUES (${names.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}
