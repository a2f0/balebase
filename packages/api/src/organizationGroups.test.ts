import { describe, expect, it } from "bun:test";
import { organizationGroups, requireCapability } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { seedAccount, seedUser } from "./testing/seed";
import { testApp } from "./testing/session";
import type { Bindings } from "./types";

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
        capabilities: ["finance"],
        memberUserIds: ["owner-user"],
        name: "Finance",
      },
    ]);
    expect(listed.body.members.map(({ user }) => user.id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    const groupId = listed.body.groups[0]?.id;
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
});

interface GroupListing {
  groups: {
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
