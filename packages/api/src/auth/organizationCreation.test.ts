import { describe, expect, it } from "bun:test";
import {
  createFixture,
  email,
  get,
  originalPassword,
  post,
} from "../testing/authFixture";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function signedInCookie(fixture: Fixture) {
  await post(fixture.auth, "/sign-up/email", {
    email,
    name: "Example Person",
    password: originalPassword,
    termsAccepted: true,
  });
  const signIn = await post(fixture.auth, "/sign-in/email", {
    email,
    password: originalPassword,
  });
  return signIn.headers.get("set-cookie");
}

async function createOrganization(
  fixture: Fixture,
  cookie: string | null,
  name: string,
) {
  const created = await post(
    fixture.auth,
    "/organization/create",
    { name, slug: `${name.toLowerCase().replaceAll(" ", "-")}-12345678` },
    cookie,
  );
  expect(created.status).toBe(200);
  return ((await created.json()) as { id: string }).id;
}

/** Every group the organization holds, with its access and members. */
function groupsOf(fixture: Fixture, organizationId: string) {
  return fixture.database
    .query(
      `SELECT "team"."name",
              (SELECT group_concat(capability) FROM organization_group_capability
               WHERE team_id = "team"."id") AS capabilities,
              (SELECT kind FROM organization_builtin_group
               WHERE team_id = "team"."id") AS builtIn,
              (SELECT group_concat(user.email) FROM "teamMember"
               JOIN user ON user.id = "teamMember"."userId"
               WHERE "teamMember"."teamId" = "team"."id") AS members
       FROM "team" WHERE "team"."organizationId" = ?
       ORDER BY "team"."createdAt", "team"."id"`,
    )
    .all(organizationId);
}

const financeGroup = {
  builtIn: "finance",
  capabilities: "finance",
  members: email,
  name: "Finance",
};

describe("organization creation", () => {
  it("starts a new organization with only its recorded Finance group", async () => {
    const fixture = await createFixture();
    const cookie = await signedInCookie(fixture);
    const organizationId = await createOrganization(
      fixture,
      cookie,
      "Field Operations",
    );

    // Better Auth's default team (named after the organization, with no
    // access) is off: it granted nothing and was created with no history.
    expect(groupsOf(fixture, organizationId)).toEqual([financeGroup]);
    expect(
      fixture.database
        .query(
          `SELECT action, root_label AS label FROM activity_events
           WHERE organization_id = ? AND root_type = 'organization_group'`,
        )
        .all(organizationId),
    ).toEqual([{ action: "organization.group_created", label: "Finance" }]);
    expect(
      await (await get(fixture.auth, "/get-session", cookie)).json(),
    ).toMatchObject({
      session: { activeOrganizationId: organizationId, activeTeamId: null },
    });
  });

  it("gives an organization named Finance its Finance group", async () => {
    const fixture = await createFixture();
    const cookie = await signedInCookie(fixture);
    const organizationId = await createOrganization(fixture, cookie, "Finance");

    // A default team named after the organization took the name first.
    expect(groupsOf(fixture, organizationId)).toEqual([financeGroup]);
  });
});
