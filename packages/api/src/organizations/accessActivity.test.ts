import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { activity } from "../activity/activity";
import { testBindings } from "../testing/bindings";
import { type D1Options, toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedAccount, seedMember, seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import { organizationGroups } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";

const organizationId = "org_owner-user";
const financeGroupId = `team_finance_${organizationId}`;
const owner = { email: "owner-user@example.com", id: "owner-user" };
const memberPerson = {
  email: "member-user@example.com",
  name: "member-user",
  userId: "member-user",
};

interface FeedEvent {
  action: string;
  actor: { email: string; id: string };
  details: Record<string, unknown>;
  root: { id: string; label: string; type: string };
  subject: { id: string; type: string };
}

describe("group access activity", () => {
  it("records the manager, granted and revoked members, and capabilities", async () => {
    const fixture = createFixture();
    const request = fixture.as("owner-user", "owner");
    const finance = { capabilities: ["finance"], name: "Finance" };

    const granted = await request(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        ...finance,
        userIds: ["owner-user", "member-user"],
      },
    );
    expect(granted.status).toBe(200);
    const revoked = await request(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        ...finance,
        userIds: ["owner-user"],
      },
    );
    expect(revoked.status).toBe(200);

    expect(await fixture.groupEvents()).toMatchObject([
      {
        action: "organization.group_updated",
        actor: owner,
        details: {
          addedCapabilities: [],
          addedMembers: [],
          name: "Finance",
          removedCapabilities: [],
          removedMembers: [memberPerson],
          renamedFrom: null,
        },
        root: { id: financeGroupId, label: "Finance" },
        subject: { id: financeGroupId, type: "organization_group" },
      },
      {
        action: "organization.group_updated",
        actor: owner,
        details: { addedMembers: [memberPerson], removedMembers: [] },
      },
    ]);
  });

  it("records nothing for an unchanged save and keeps unchanged rows", async () => {
    const fixture = createFixture();
    const request = fixture.as("owner-user", "owner");
    const before = fixture.groupRows();
    const response = await request(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        capabilities: ["finance"],
        name: "Finance",
        userIds: ["owner-user"],
      },
    );
    expect(response.status).toBe(200);
    expect(await fixture.groupEvents()).toEqual([]);
    // Membership timestamps survive a save that leaves the member in place.
    expect(fixture.groupRows()).toEqual(before);
  });

  it("records renames and capability changes", async () => {
    const fixture = createFixture();
    const request = fixture.as("owner-user", "owner");
    expect(
      (
        await request("PATCH", `/api/organization-groups/${financeGroupId}`, {
          capabilities: [],
          name: "Books",
          userIds: ["owner-user"],
        })
      ).status,
    ).toBe(200);
    expect(await fixture.groupEvents()).toMatchObject([
      {
        details: {
          addedCapabilities: [],
          name: "Books",
          removedCapabilities: ["finance"],
          renamedFrom: "Finance",
        },
        root: { label: "Books" },
      },
    ]);
  });

  it("records creation and deletion snapshots, and keeps them after deletion", async () => {
    const fixture = createFixture();
    const request = fixture.as("owner-user", "owner");
    const created = await request<{ id: string }>(
      "POST",
      "/api/organization-groups",
      {
        capabilities: ["finance"],
        name: "Payables",
        userIds: ["member-user", "owner-user"],
      },
    );
    expect(created.status).toBe(201);
    const deleted = await request(
      "DELETE",
      `/api/organization-groups/${created.body.id}`,
    );
    expect(deleted.status).toBe(204);
    const snapshot = {
      capabilities: ["finance"],
      members: [
        memberPerson,
        { email: owner.email, name: "owner-user", userId: owner.id },
      ],
      name: "Payables",
    };
    expect(await fixture.groupEvents()).toMatchObject([
      {
        action: "organization.group_deleted",
        actor: owner,
        details: snapshot,
        root: { id: created.body.id, label: "Payables" },
      },
      {
        action: "organization.group_created",
        actor: owner,
        details: snapshot,
        root: { id: created.body.id, label: "Payables" },
      },
    ]);
  });

  it("rolls back the change when its history cannot be written", async () => {
    const fixture = createFixture();
    const before = fixture.groupRows();
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const request = fixture.as("owner-user", "owner");
    const response = await request(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        capabilities: ["finance"],
        name: "Finance",
        userIds: ["owner-user", "member-user"],
      },
    );
    expect(response.status).toBe(500);
    expect(fixture.groupRows()).toEqual(before);
    const deleted = await request(
      "DELETE",
      `/api/organization-groups/${financeGroupId}`,
    );
    expect(deleted.status).toBe(500);
    expect(fixture.groupRows()).toEqual(before);
  });

  it("refuses a manager demoted after the request began", async () => {
    const fixture = createFixture();
    fixture.database.exec(
      "UPDATE member SET role = 'member' WHERE id = 'member_owner-user'",
    );
    const before = fixture.groupRows();
    const request = fixture.as("owner-user", "owner");
    for (const [method, path] of [
      ["PATCH", `/api/organization-groups/${financeGroupId}`],
      ["POST", "/api/organization-groups"],
      ["DELETE", `/api/organization-groups/${financeGroupId}`],
    ] as const) {
      const response = await request(method, path, {
        capabilities: ["finance"],
        name: method === "POST" ? "Payables" : "Finance",
        userIds: ["member-user"],
      });
      expect(response).toMatchObject({
        body: { error: "Organization manager access required." },
        status: 403,
      });
    }
    expect(fixture.groupRows()).toEqual(before);
    expect(fixture.eventCount()).toBe(0);
  });

  it("records the stored state when another save lands first", async () => {
    let raced = false;
    const fixture = createFixture({
      onQuery: (event) => {
        if (raced || event.method !== "batch") return;
        if (!event.sql.includes("AS added_members")) return;
        raced = true;
        // A concurrent save already granted this member.
        fixture.database
          .query(
            `INSERT INTO teamMember (id, teamId, userId, membershipKey, createdAt)
             VALUES ('raced', ?, 'member-user', NULL, '2026-10-01T00:00:00.000Z')`,
          )
          .run(financeGroupId);
      },
    });
    const request = fixture.as("owner-user", "owner");
    const response = await request(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        capabilities: [],
        name: "Finance",
        userIds: ["owner-user", "member-user"],
      },
    );
    expect(response.status).toBe(200);
    expect(raced).toBe(true);
    expect(await fixture.groupEvents()).toMatchObject([
      {
        details: { addedMembers: [], removedCapabilities: ["finance"] },
      },
    ]);
    expect(
      fixture.database
        .query("SELECT id FROM teamMember WHERE userId = 'member-user'")
        .all(),
    ).toEqual([{ id: "raced" }]);
  });

  it("shows group history only to managers of the organization", async () => {
    const fixture = createFixture();
    await fixture.as("owner-user", "owner")(
      "PATCH",
      `/api/organization-groups/${financeGroupId}`,
      {
        capabilities: ["finance"],
        name: "Finance",
        userIds: ["owner-user", "member-user"],
      },
    );
    expect(await fixture.groupEvents()).toHaveLength(1);
    const member = fixture.as("member-user", "member");
    for (const path of [
      "/api/activity",
      "/api/activity?resourceType=organization_group",
    ])
      expect(
        (await member<{ events: FeedEvent[]; nextCursor: null }>("GET", path))
          .body,
      ).toEqual({
        events: [],
        nextCursor: null,
      });
    const outsider = fixture.as("outside-user", "owner", "org_outside-user");
    expect(
      (await outsider<{ events: FeedEvent[] }>("GET", "/api/activity")).body
        .events,
    ).toEqual([]);
  });
});

describe("two-factor requirement activity", () => {
  const path =
    "/api/organization-settings/people/target-member/two-factor-required";

  it("records each committed transition and nothing for a repeat", async () => {
    const fixture = createFixture();
    const request = fixture.as("owner-user", "owner");
    for (const required of [true, true, false])
      expect((await request("PATCH", path, { required })).status).toBe(200);
    const events = await fixture.memberEvents();
    expect(events).toMatchObject([
      {
        action: "organization.member_two_factor_requirement_changed",
        actor: owner,
        details: {
          after: false,
          before: true,
          userEmail: memberPerson.email,
          userId: memberPerson.userId,
          userName: memberPerson.name,
        },
        root: {
          id: "target-member",
          label: "member-user",
          type: "organization_member",
        },
      },
      {
        action: "organization.member_two_factor_requirement_changed",
        details: { after: true, before: false },
      },
    ]);
    expect(events).toHaveLength(2);
  });

  it("records nothing for denied writes or missing members", async () => {
    const fixture = createFixture();
    expect(
      (
        await fixture.as("member-user", "member")("PATCH", path, {
          required: true,
        })
      ).status,
    ).toBe(403);
    const request = fixture.as("owner-user", "owner");
    expect(
      (
        await request(
          "PATCH",
          "/api/organization-settings/people/fallback-member/two-factor-required",
          {
            required: true,
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "PATCH",
          "/api/organization-settings/people/missing/two-factor-required",
          {
            required: true,
          },
        )
      ).status,
    ).toBe(404);
    expect(fixture.eventCount()).toBe(0);
    expect(fixture.twoFactorRequired("fallback-member")).toBe(0);
  });

  it("refuses a manager demoted after the request began", async () => {
    const fixture = createFixture();
    fixture.database.exec(
      "UPDATE member SET role = 'member' WHERE id = 'member_owner-user'",
    );
    const response = await fixture.as("owner-user", "owner")("PATCH", path, {
      required: true,
    });
    expect(response).toMatchObject({
      body: { error: "Organization manager access required." },
      status: 403,
    });
    expect(fixture.twoFactorRequired("target-member")).toBe(0);
    expect(fixture.eventCount()).toBe(0);
  });

  it("keeps the flag when its history cannot be written", async () => {
    const fixture = createFixture();
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const response = await fixture.as("owner-user", "owner")("PATCH", path, {
      required: true,
    });
    expect(response.status).toBe(500);
    expect(fixture.twoFactorRequired("target-member")).toBe(0);
  });

  it("is manager-only and survives the member leaving", async () => {
    const fixture = createFixture();
    await fixture.as("owner-user", "owner")("PATCH", path, { required: true });
    fixture.database.exec("DELETE FROM member WHERE id = 'target-member'");
    expect(await fixture.memberEvents()).toHaveLength(1);
    const member = fixture.as("member-user", "member");
    expect(
      (
        await member<{ events: FeedEvent[] }>(
          "GET",
          "/api/activity?resourceType=organization_member",
        )
      ).body.events,
    ).toEqual([]);
  });
});

function createFixture(options: D1Options = {}) {
  const database = createTestDatabase();
  seedAccount(database, { id: "owner-user" });
  seedAccount(database, { id: "outside-user" });
  seedUser(database, { id: "member-user" });
  seedMember(database, {
    id: "target-member",
    organizationId,
    userId: "member-user",
  });
  seedMember(database, {
    id: "fallback-member",
    organizationId: "org_outside-user",
    userId: "member-user",
  });
  const bindings = testBindings({ DB: toD1(database, options) });
  const as = (
    userId: string,
    organizationRole: string,
    organization = organizationId,
  ) =>
    requester(
      testApp(
        {
          "/api/activity": activity,
          "/api/organization-groups": organizationGroups,
          "/api/organization-settings": organizationSettings,
        },
        { organizationId: organization, organizationRole, userId },
      ),
      bindings,
    );
  const feed = async (resourceType: string) =>
    (
      await as("owner-user", "owner")<{ events: FeedEvent[] }>(
        "GET",
        `/api/activity?resourceType=${resourceType}`,
      )
    ).body.events;
  return {
    as,
    database,
    eventCount: () =>
      (
        database
          .query(
            "SELECT COUNT(*) AS count FROM activity_events WHERE organization_id IS NOT NULL",
          )
          .get() as {
          count: number;
        }
      ).count,
    groupEvents: () => feed("organization_group"),
    groupRows: () => groupRows(database),
    memberEvents: () => feed("organization_member"),
    twoFactorRequired: (memberId: string) =>
      (
        database
          .query("SELECT twoFactorRequired FROM member WHERE id = ?")
          .get(memberId) as { twoFactorRequired: number }
      ).twoFactorRequired,
  };
}

function groupRows(database: Database) {
  return {
    capabilities: database
      .query(
        "SELECT team_id, capability FROM organization_group_capability ORDER BY 1, 2",
      )
      .all(),
    members: database
      .query("SELECT * FROM teamMember ORDER BY teamId, userId")
      .all(),
    teams: database
      .query('SELECT id, name, "organizationId" FROM team ORDER BY id')
      .all(),
  };
}
