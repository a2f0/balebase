import { describe, expect, it } from "bun:test";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedAccount, seedGroup, seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import type { Bindings } from "../types";
import { organizationGroups, requireCapability } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";

const organizationId = "org_owner-user";

describe("organization groups", () => {
  it("lets organization managers grant and revoke Finance access", async () => {
    const fixture = createFixture();
    const owner = groupsApp(fixture.bindings, "owner-user");
    const member = groupsApp(fixture.bindings, "member-user");

    const listed = await owner<GroupListing>("GET", "/");
    expect(listed.status).toBe(200);
    expect(listed.body.groups).toMatchObject([
      {
        builtIn: "admins",
        capabilities: [],
        id: "admins",
        memberUserIds: ["owner-user"],
        name: "Admins",
      },
      {
        builtIn: "finance",
        capabilities: ["finance"],
        memberUserIds: ["owner-user"],
        name: "Finance",
      },
    ]);
    expect(listed.body.members.map(({ user }) => user.id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    const groupId = listed.body.groups[1]?.id;
    expect(groupId).toBeString();

    const memberAccess = await member<AccessListing>("GET", "/access");
    expect(memberAccess.body.capabilities).toEqual([]);
    expect(memberAccess.body.memberRole).toBe("member");
    expect(memberAccess.body.ownerCount).toBe(1);
    expect((await member("GET", "/")).status).toBe(403);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      403,
    );

    const granted = await owner("PATCH", `/${groupId}`, {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["owner-user", "member-user"],
    });
    expect(granted.status).toBe(200);
    expect(
      (await member<AccessListing>("GET", "/access")).body.capabilities,
    ).toEqual(["finance"]);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      200,
    );

    const valid = { capabilities: ["finance"], name: "Ops", userIds: [] };
    for (const body of [
      null,
      { ...valid, name: "  " },
      { ...valid, name: "x".repeat(101) },
      { ...valid, capabilities: ["payroll"] },
      { ...valid, userIds: Array.from({ length: 101 }, () => "owner-user") },
      { ...valid, userIds: [7] },
    ]) {
      expect(await owner("POST", "/", body)).toMatchObject({
        body: {
          error: "A valid group name, members, and capabilities are required.",
        },
        status: 400,
      });
    }
    const deduplicated = await owner<{ id: string }>("POST", "/", {
      ...valid,
      capabilities: ["finance", "finance"],
      userIds: [" owner-user ", "owner-user", ""],
    });
    expect(deduplicated.status).toBe(201);
    expect(
      (await owner<GroupListing>("GET", "/")).body.groups.find(
        ({ id }) => id === deduplicated.body.id,
      ),
    ).toMatchObject({
      capabilities: ["finance"],
      memberUserIds: ["owner-user"],
    });

    const invalidMember = await owner("PATCH", `/${groupId}`, {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["outside-user"],
    });
    expect(invalidMember.status).toBe(400);

    const revoked = await owner("PATCH", `/${groupId}`, {
      capabilities: ["finance"],
      name: "Finance",
      userIds: ["owner-user"],
    });
    expect(revoked.status).toBe(200);
    expect((await financeRequest(fixture.bindings, "member-user")).status).toBe(
      403,
    );
  });

  it("aggregates members and manager-only pending invitations", async () => {
    const fixture = createFixture();
    const owner = settingsApp(fixture.bindings, "owner-user");
    const member = settingsApp(fixture.bindings, "member-user");

    const ownerListing = await owner<PeopleListing>("GET", "/people");
    expect(ownerListing.status).toBe(200);
    expect(ownerListing.body.memberRole).toBe("owner");
    expect(ownerListing.body.members.map(({ user }) => user.id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    expect(ownerListing.body.invitations).toMatchObject([
      { email: "invited@example.com", role: "admin", status: "pending" },
    ]);

    const memberListing = await member<PeopleListing>("GET", "/people");
    expect(memberListing.status).toBe(200);
    expect(memberListing.body.memberRole).toBe("member");
    expect(memberListing.body.members).toHaveLength(2);
    expect(memberListing.body.invitations).toEqual([]);
    for (const listedMember of memberListing.body.members) {
      expect(listedMember).not.toHaveProperty("lastActiveAt");
      expect(listedMember).not.toHaveProperty("twoFactorEnabled");
      expect(listedMember).not.toHaveProperty("twoFactorRequired");
    }
  });

  it("creates and deletes arbitrary organization groups", async () => {
    const fixture = createFixture();
    const owner = groupsApp(fixture.bindings, "owner-user");
    const created = await owner<{ id: string }>("POST", "/", {
      capabilities: [],
      name: "Operations",
      userIds: ["member-user"],
    });
    expect(created.status).toBe(201);
    expect((await owner<GroupListing>("GET", "/")).body.groups).toContainEqual(
      expect.objectContaining({
        memberUserIds: ["member-user"],
        name: "Operations",
      }),
    );
    const deleted = await owner("DELETE", `/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(
      (await owner<GroupListing>("GET", "/")).body.groups,
    ).not.toContainEqual(expect.objectContaining({ name: "Operations" }));
  });

  it("keeps built-in groups: Finance can change but not be deleted, Admins follows roles", async () => {
    const fixture = createFixture();
    const owner = groupsApp(fixture.bindings, "owner-user");
    const financeId = "team_finance_org_owner-user";

    expect(await owner("DELETE", `/${financeId}`)).toMatchObject({
      body: { error: "Built-in groups can't be deleted." },
      status: 409,
    });
    const renamed = await owner("PATCH", `/${financeId}`, {
      capabilities: ["finance"],
      name: "Accounts",
      userIds: ["owner-user", "member-user"],
    });
    expect(renamed.status).toBe(200);
    const admins = { capabilities: [], name: "Admins", userIds: [] };
    for (const [method, body] of [
      ["PATCH", admins],
      ["DELETE", undefined],
    ] as const) {
      expect(await owner(method, "/admins", body)).toMatchObject({
        body: {
          error:
            "The Admins group follows member roles. Change a member's role in People.",
        },
        status: 409,
      });
    }

    fixture.database.exec(
      "UPDATE member SET role = 'admin' WHERE id = 'member-record'",
    );
    const { groups } = (await owner<GroupListing>("GET", "/")).body;
    expect(groups.map(({ builtIn, name }) => [builtIn, name])).toEqual([
      ["admins", "Admins"],
      ["finance", "Accounts"],
    ]);
    expect(groups[0]?.memberUserIds.toSorted()).toEqual([
      "member-user",
      "owner-user",
    ]);
    const events = fixture.database
      .query("SELECT action FROM activity_events WHERE root_id = ? ORDER BY id")
      .all(financeId);
    expect(events).toEqual([{ action: "organization.group_updated" }]);
  });

  it("refuses to delete a group that became built in during the request", async () => {
    const database = createFixture().database;
    seedGroup(database, { id: "payables", name: "Payables", organizationId });
    const bindings = testBindings({
      DB: toD1(database, {
        onQuery: ({ sql }) => {
          if (sql.startsWith('DELETE FROM "team"'))
            database.exec(
              `INSERT OR IGNORE INTO organization_builtin_group
               (team_id, organization_id, kind) VALUES ('payables', '${organizationId}', 'finance')`,
            );
        },
      }),
    });
    // The organization's own built-in Finance group is replaced in this test.
    database.exec(
      "DELETE FROM organization_builtin_group WHERE team_id = 'team_finance_org_owner-user'",
    );
    const owner = groupsApp(bindings, "owner-user");
    expect(await owner("DELETE", "/payables")).toMatchObject({
      body: { error: "Built-in groups can't be deleted." },
      status: 409,
    });
    expect(
      database.query("SELECT id FROM team WHERE id = 'payables'").get(),
    ).toEqual({ id: "payables" });
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_id = 'payables'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("reads a group's history, and the Admins group's role changes, for managers", async () => {
    const fixture = createFixture();
    const owner = groupsApp(fixture.bindings, "owner-user");
    const member = groupsApp(fixture.bindings, "member-user");
    const financeId = "team_finance_org_owner-user";
    await owner("PATCH", `/${financeId}`, {
      capabilities: [],
      name: "Finance",
      userIds: ["owner-user"],
    });
    fixture.database
      .query(
        `INSERT INTO activity_events (organization_id, root_type, root_id,
           root_label, subject_type, subject_id, action, actor_user_id,
           actor_name, actor_email, occurred_at, details)
         VALUES (?, 'organization_member', 'member-record', 'member', 'organization_member',
           'member-record', 'organization.member_role_changed', 'owner-user', 'Owner',
           'owner@example.com', ?, '{}')`,
      )
      .run(organizationId, now());

    const history = await owner<{ events: { action: string }[] }>(
      "GET",
      `/${financeId}/activity`,
    );
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "organization.group_updated",
    ]);
    const roles = await owner<{ events: { action: string }[] }>(
      "GET",
      "/admins/activity",
    );
    expect(roles.body.events.map(({ action }) => action)).toEqual([
      "organization.member_role_changed",
    ]);
    expect((await owner("GET", "/missing/activity")).status).toBe(404);
    expect((await member("GET", `/${financeId}/activity`)).status).toBe(403);
  });
});

interface GroupListing {
  groups: {
    builtIn: string | null;
    capabilities: string[];
    id: string;
    memberUserIds: string[];
    name: string;
  }[];
  members: MemberListing[];
}

interface AccessListing {
  capabilities: string[];
  memberRole: string;
  ownerCount: number;
}

interface MemberListing {
  id: string;
  role: string;
  twoFactorEnabled?: boolean;
  twoFactorRequired?: boolean;
  user: { email: string; id: string; name: string };
}

interface PeopleListing {
  invitations: {
    email: string;
    expiresAt: string;
    id: string;
    role: string;
    status: string;
  }[];
  memberRole: string;
  members: MemberListing[];
}

function createFixture() {
  const database = createTestDatabase();
  seedAccount(database, {
    createdAt: now(),
    email: "owner@example.com",
    id: "owner-user",
  });
  seedUser(database, {
    createdAt: now(),
    email: "member@example.com",
    id: "member-user",
  });
  seedUser(database, {
    createdAt: now(),
    email: "outside@example.com",
    id: "outside-user",
  });
  database
    .query(
      `INSERT INTO "member"
       ("id", "organizationId", "userId", "role", "createdAt")
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run("member-record", organizationId, "member-user", now());
  database
    .query(
      `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       VALUES (?, ?, ?, 'admin', 'pending', ?, ?, ?)`,
    )
    .run(
      "pending-invitation",
      organizationId,
      "invited@example.com",
      "2026-08-21T12:00:00.000Z",
      now(),
      "owner-user",
    );
  return { bindings: testBindings({ DB: toD1(database) }), database };
}

function identity(userId: string) {
  return {
    organizationId,
    organizationRole: userId === "owner-user" ? "owner" : "member",
    userId,
  };
}

function groupsApp(bindings: Bindings, userId: string) {
  return requester(
    testApp({ "/": organizationGroups }, identity(userId)),
    bindings,
  );
}

function settingsApp(bindings: Bindings, userId: string) {
  return requester(
    testApp({ "/": organizationSettings }, identity(userId)),
    bindings,
  );
}

async function financeRequest(bindings: Bindings, userId: string) {
  const app = testApp({}, identity(userId));
  app.use("/finance", requireCapability("finance"));
  app.get("/finance", (context) => context.json({ ok: true }));
  return requester(app, bindings)("GET", "/finance");
}

function now() {
  return "2026-08-19T12:00:00.000Z";
}
