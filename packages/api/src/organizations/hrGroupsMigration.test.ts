import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";
import {
  seedGroup,
  seedMember,
  seedOrganization,
  seedUser,
} from "../testing/seed";

/**
 * Removable once production has applied 0108 (CONTRIBUTING.md, Database):
 * it covers only the HR groups made for organizations that existed before it.
 * Sign-up's HR group is covered in `auth/organizationCreation.test.ts`.
 */
it("gives each organization an HR group of its owners and admins, granting Background checks", () => {
  const database = createTestDatabase({ before: "0108" });
  for (const id of ["ada", "bea", "cy", "dee", "eve"])
    seedUser(database, { id, name: id.toUpperCase() });
  seedOrganization(database, { id: "acme" });
  seedOrganization(database, { id: "beta" });
  seedMember(database, {
    organizationId: "acme",
    role: "owner",
    userId: "ada",
  });
  seedMember(database, {
    organizationId: "acme",
    role: "member, admin",
    userId: "bea",
  });
  seedMember(database, { organizationId: "acme", userId: "cy" });
  seedMember(database, {
    organizationId: "beta",
    role: "admin",
    userId: "dee",
  });
  seedMember(database, { organizationId: "beta", userId: "eve" });
  seedGroup(database, {
    builtIn: "finance",
    organizationId: "acme",
    userIds: ["ada"],
  });
  // Beta already named a group HR; it stays as it was.
  seedGroup(database, {
    capabilities: [],
    id: "beta-hr",
    name: "hr",
    organizationId: "beta",
    userIds: ["eve"],
  });

  applyMigrations(database, { from: "0108" });

  expect(
    database
      .query(
        `SELECT "team"."organizationId" AS organization, "team"."name",
                "team"."memberCount" AS memberCount, builtin.kind AS builtIn,
                (SELECT group_concat(capability) FROM organization_group_capability
                 WHERE team_id = "team"."id") AS capabilities,
                (SELECT group_concat("userId", ',') FROM (
                   SELECT "userId" FROM "teamMember"
                   WHERE "teamId" = "team"."id" ORDER BY "userId")) AS members
         FROM "team"
         LEFT JOIN organization_builtin_group AS builtin
           ON builtin.team_id = "team"."id"
         ORDER BY organization, "team"."name"`,
      )
      .all(),
  ).toEqual([
    {
      builtIn: "finance",
      capabilities: "finance",
      memberCount: 1,
      members: "ada",
      name: "Finance",
      organization: "acme",
    },
    {
      builtIn: "hr",
      capabilities: "background_checks",
      memberCount: 2,
      members: "ada,bea",
      name: "HR",
      organization: "acme",
    },
    {
      builtIn: "hr",
      capabilities: "background_checks",
      memberCount: 1,
      members: "dee",
      name: "HR (built-in)",
      organization: "beta",
    },
    {
      builtIn: null,
      capabilities: null,
      memberCount: 1,
      members: "eve",
      name: "hr",
      organization: "beta",
    },
  ]);

  // Each group's creation, by Balebase's maintenance rather than a person.
  const events = database
    .query(
      `SELECT organization_id, action, root_label, actor_type, actor_source,
              actor_user_id, actor_name, actor_email, details
       FROM activity_events WHERE root_type = 'organization_group'
       ORDER BY organization_id`,
    )
    .all() as Array<Record<string, string | null>>;
  expect(
    events.map(
      ({ details, ...event }): Record<string, unknown> => ({
        ...event,
        details: JSON.parse(details ?? "null"),
      }),
    ),
  ).toEqual([
    {
      action: "organization.group_created",
      actor_email: "",
      actor_name: "Balebase maintenance",
      actor_source: "createHrGroups",
      actor_type: "system",
      actor_user_id: null,
      details: {
        capabilities: ["background_checks"],
        members: [
          { email: "ada@example.com", name: "ADA", userId: "ada" },
          { email: "bea@example.com", name: "BEA", userId: "bea" },
        ],
        name: "HR",
      },
      organization_id: "acme",
      root_label: "HR",
    },
    {
      action: "organization.group_created",
      actor_email: "",
      actor_name: "Balebase maintenance",
      actor_source: "createHrGroups",
      actor_type: "system",
      actor_user_id: null,
      details: {
        capabilities: ["background_checks"],
        members: [{ email: "dee@example.com", name: "DEE", userId: "dee" }],
        name: "HR (built-in)",
      },
      organization_id: "beta",
      root_label: "HR (built-in)",
    },
  ]);

  // The rebuilt table still keeps one built-in group of each kind.
  expect(() =>
    database.run(
      `INSERT INTO organization_builtin_group (team_id, organization_id, kind)
       VALUES ('beta-hr', 'beta', 'hr')`,
    ),
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    database.run(
      `INSERT INTO organization_builtin_group (team_id, organization_id, kind)
       VALUES ('beta-hr', 'beta', 'payroll')`,
    ),
  ).toThrow("CHECK constraint failed");
});
