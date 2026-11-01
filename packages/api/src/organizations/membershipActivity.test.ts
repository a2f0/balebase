import { describe, expect, it } from "bun:test";
import { app } from "../app";
import { findActivity } from "../shared/activity";
import {
  CookieJar,
  createFixture,
  email,
  executionContext,
  originalPassword,
  post,
} from "../testing/authFixture";
import { insertBilling } from "../testing/seed";
import { removeMemberWithActivity } from "./memberRemoval";

describe("member removal activity", () => {
  it("records who removed a member, the groups and equipment they lost, and their keys", async () => {
    const fixture = await createMembershipFixture();
    // Bob administers the organization, so his unexpired key works until now;
    // his expired one already stopped.
    fixture.database.exec("UPDATE member SET role = 'admin' WHERE id = 'bob'");
    const response = await fixture.remove("bob");
    expect(response.status).toBe(200);

    const events = await fixture.events();
    expect(events.map(({ action }) => action)).toEqual([
      "equipment.assigned",
      "organization.group_updated",
      "organization.member_removed",
    ]);
    const [equipment, group, removal] = events;
    expect(removal).toMatchObject({
      actor: { id: fixture.owner.id, name: "Alice", email },
      details: {
        apiKeys: [{ id: "bob-key", name: "Bob's key" }],
        role: "admin",
        userEmail: "bob@example.com",
        userId: fixture.bob.id,
        userName: "Bob",
      },
      root: { id: "bob", label: "Bob", type: "organization_member" },
      subject: { id: "bob", type: "organization_member" },
    });
    expect(group).toMatchObject({
      actor: { id: fixture.owner.id },
      details: {
        addedCapabilities: [],
        addedMembers: [],
        capabilities: ["finance"],
        name: "Finance",
        reason: "member_removed",
        removedCapabilities: [],
        removedMembers: [
          { email: "bob@example.com", name: "Bob", userId: fixture.bob.id },
        ],
      },
      root: { label: "Finance", type: "organization_group" },
    });
    expect(equipment).toMatchObject({
      actor: { id: fixture.owner.id },
      details: {
        after: null,
        afterName: null,
        before: fixture.bob.id,
        beforeEmail: "bob@example.com",
        beforeName: "Bob",
        reason: "member_removed",
      },
      root: { id: "laptop", label: "Apple MacBook", type: "equipment" },
    });
    expect(fixture.state()).toEqual({
      financeMembers: [fixture.owner.id],
      laptopAssignee: null,
      memberCount: 1,
      members: ["alice", "carol"],
    });

    // Everyone sees the removal and the equipment change; only managers see
    // the group access it revoked.
    const carolFeed = await fixture.feed(fixture.carol.cookie);
    expect(carolFeed.map(({ action }) => action)).toEqual([
      "equipment.assigned",
      "organization.member_removed",
    ]);
    const ownerFeed = await fixture.feed(fixture.owner.cookie);
    expect(ownerFeed.map(({ action }) => action)).toContain(
      "organization.group_updated",
    );
    // Bob's own organization records nothing.
    expect(
      (await findActivity(fixture.bindings.DB, fixture.bob.organizationId))
        ?.events,
    ).toEqual([]);
    await Promise.all(fixture.pending);
  });

  it("distinguishes leaving from being removed", async () => {
    const fixture = await createMembershipFixture();
    const response = await app.request(
      "/api/auth/organization/leave",
      {
        body: JSON.stringify({ organizationId: fixture.organizationId }),
        headers: {
          "content-type": "application/json",
          cookie: fixture.bob.cookie,
          origin: "https://app.test",
        },
        method: "POST",
      },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(response.status).toBe(200);
    const events = await fixture.events();
    expect(
      events.map(({ action, actor, details }) => [
        action,
        actor.id,
        details.reason,
      ]),
    ).toEqual([
      ["equipment.assigned", fixture.bob.id, "member_left"],
      ["organization.group_updated", fixture.bob.id, "member_left"],
      ["organization.member_left", fixture.bob.id, undefined],
    ]);
    expect(fixture.state().members).toEqual(["alice", "carol"]);
    await Promise.all(fixture.pending);
  });

  it("records only the membership when the person held no groups or equipment", async () => {
    const fixture = await createMembershipFixture();
    expect((await fixture.remove("carol")).status).toBe(200);
    const events = await fixture.events();
    expect(events.map(({ action }) => action)).toEqual([
      "organization.member_removed",
    ]);
    expect(events[0]?.details).toMatchObject({
      apiKeys: [],
      userName: "Carol",
    });
  });

  it("records nothing for denied removals", async () => {
    const fixture = await createMembershipFixture();
    // A plain member cannot remove anyone.
    expect((await fixture.remove("bob", fixture.carol.cookie)).status).toBe(
      401,
    );
    // The last owner cannot leave.
    const lastOwner = await post(
      fixture.auth,
      "/organization/leave",
      { organizationId: fixture.organizationId },
      fixture.owner.cookie,
    );
    expect(lastOwner.status).toBe(400);
    expect((await fixture.remove("missing-member")).status).toBe(400);
    expect(await fixture.events()).toEqual([]);
    expect(fixture.state().members).toEqual(["alice", "bob", "carol"]);
  });

  it("rechecks the remover's authority inside the transaction", async () => {
    const fixture = await createMembershipFixture();
    fixture.database.exec(
      "UPDATE member SET role = 'member' WHERE id = 'carol'",
    );
    // Carol was demoted after the request was authorized.
    expect(
      await removeMemberWithActivity(fixture.bindings.DB, {
        actorId: fixture.carol.id,
        memberId: "bob",
        reason: "member_removed",
      }),
    ).toBe("forbidden");
    // An owner leaving while no other owner remains changes nothing.
    expect(
      await removeMemberWithActivity(fixture.bindings.DB, {
        actorId: fixture.owner.id,
        memberId: "alice",
        reason: "member_left",
      }),
    ).toBe("forbidden");
    expect(
      await removeMemberWithActivity(fixture.bindings.DB, {
        actorId: fixture.owner.id,
        memberId: "gone",
        reason: "member_removed",
      }),
    ).toBe("not_found");
    expect(await fixture.events()).toEqual([]);
    expect(fixture.state()).toMatchObject({
      financeMembers: [fixture.owner.id, fixture.bob.id].toSorted(),
      laptopAssignee: fixture.bob.id,
      members: ["alice", "bob", "carol"],
    });
  });

  it("keeps the membership, groups and equipment when the history cannot be written", async () => {
    const fixture = await createMembershipFixture();
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect((await fixture.remove("bob")).status).toBe(500);
    fixture.database.exec("DROP TRIGGER reject_activity");
    expect(await fixture.events()).toEqual([]);
    expect(fixture.state()).toEqual({
      financeMembers: [fixture.owner.id, fixture.bob.id].toSorted(),
      laptopAssignee: fixture.bob.id,
      memberCount: 2,
      members: ["alice", "bob", "carol"],
    });
  });
});

describe("invitation activity", () => {
  it("records invitations, cancellations, re-invites and rejections for managers", async () => {
    const fixture = await createMembershipFixture();
    const carolInvite = await fixture.invite("dana@example.com", "admin");
    expect(carolInvite.status).toBe(200);
    const first = (await carolInvite.json()) as { id: string };
    const cancel = await post(
      fixture.auth,
      "/organization/cancel-invitation",
      { invitationId: first.id },
      fixture.owner.cookie,
    );
    expect(cancel.status).toBe(200);

    const erin = await fixture.invite("erin@example.com", "member");
    const erinFirst = (await erin.json()) as { id: string };
    // A second invitation to the same address cancels the pending one.
    const reinvite = await fixture.invite("erin@example.com", "admin");
    expect(reinvite.status).toBe(200);
    const erinSecond = (await reinvite.json()) as { id: string };
    const erinPerson = await fixture.person("erin@example.com", "Erin");
    const reject = await post(
      fixture.auth,
      "/organization/reject-invitation",
      { invitationId: erinSecond.id },
      erinPerson.cookie,
    );
    expect(reject.status).toBe(200);

    const events = (await fixture.events()).toReversed();
    expect(
      events.map(({ action, actor, root, details }) => ({
        action,
        actor: actor.id,
        root: root.id,
        email: details.email,
        role: details.role,
      })),
    ).toEqual([
      {
        action: "organization.invitation_created",
        actor: fixture.owner.id,
        email: "dana@example.com",
        role: "admin",
        root: first.id,
      },
      {
        action: "organization.invitation_canceled",
        actor: fixture.owner.id,
        email: "dana@example.com",
        role: "admin",
        root: first.id,
      },
      {
        action: "organization.invitation_created",
        actor: fixture.owner.id,
        email: "erin@example.com",
        role: "member",
        root: erinFirst.id,
      },
      {
        action: "organization.invitation_canceled",
        actor: fixture.owner.id,
        email: "erin@example.com",
        role: "member",
        root: erinFirst.id,
      },
      {
        action: "organization.invitation_created",
        actor: fixture.owner.id,
        email: "erin@example.com",
        role: "admin",
        root: erinSecond.id,
      },
      {
        action: "organization.invitation_rejected",
        actor: erinPerson.id,
        email: "erin@example.com",
        role: "admin",
        root: erinSecond.id,
      },
    ]);
    expect(events[1]?.details).toMatchObject({
      after: "canceled",
      before: "pending",
    });
    expect(events[0]).toMatchObject({
      root: { label: "dana@example.com", type: "organization_invitation" },
    });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM invitation WHERE activity_actor_id IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 0 });

    // Invited addresses stay with managers, as on the people page.
    expect(await fixture.feed(fixture.carol.cookie)).toEqual([]);
    const filtered = await app.request(
      "/api/activity?resourceType=organization_invitation",
      { headers: { cookie: fixture.owner.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(
      ((await filtered.json()) as { events: unknown[] }).events,
    ).toHaveLength(6);
    await Promise.all(fixture.pending);
  });

  it("records who joined through an invitation, with the role and the inviter", async () => {
    const fixture = await createMembershipFixture();
    const invite = await fixture.invite("dana@example.com", "admin");
    const invitation = (await invite.json()) as { id: string };
    const dana = await fixture.person("dana@example.com", "Dana");
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: invitation.id },
      dana.cookie,
    );
    expect(accepted.status).toBe(200);
    const member = fixture.database
      .query(
        `SELECT id, role, activity_invitation_id FROM member
         WHERE userId = ? AND organizationId = ?`,
      )
      .get(dana.id, fixture.organizationId) as {
      activity_invitation_id: string;
      id: string;
      role: string;
    };
    expect(member).toMatchObject({
      activity_invitation_id: invitation.id,
      role: "admin",
    });
    const events = await fixture.events();
    expect(events.map(({ action }) => action)).toEqual([
      "organization.invitation_accepted",
      "organization.member_joined",
      "organization.invitation_created",
    ]);
    expect(events[1]).toMatchObject({
      actor: { email: "dana@example.com", id: dana.id, name: "Dana" },
      details: {
        invitedRole: "admin",
        inviterEmail: email,
        inviterId: fixture.owner.id,
        inviterName: "Alice",
        role: "admin",
        userEmail: "dana@example.com",
        userId: dana.id,
        userName: "Dana",
      },
      root: { id: member.id, label: "Dana", type: "organization_member" },
    });
    expect(events[0]).toMatchObject({
      actor: { id: dana.id },
      details: { memberId: member.id, role: "admin", userId: dana.id },
      root: { id: invitation.id, type: "organization_invitation" },
    });
    // Members see who joined, but not the invitation itself.
    expect(
      (await fixture.feed(fixture.carol.cookie)).map(({ action }) => action),
    ).toEqual(["organization.member_joined"]);
    await Promise.all(fixture.pending);
  });

  it("records nothing for refused invitations, and nothing for members added directly", async () => {
    const fixture = await createMembershipFixture();
    expect(
      (await fixture.invite("dana@example.com", "member", fixture.carol.cookie))
        .status,
    ).toBe(403);
    const withGroup = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: "dana@example.com",
        organizationId: fixture.organizationId,
        role: "member",
        teamId: "team-finance",
      },
      fixture.owner.cookie,
    );
    expect(withGroup.status).toBeGreaterThanOrEqual(400);
    fixture.database
      .query(
        `INSERT INTO invitation (id, organizationId, email, role, status,
           expiresAt, createdAt, inviterId)
         VALUES ('seeded', ?, 'seed@example.com', 'member', 'pending',
                 '2099-01-01', '2026-10-01', ?)`,
      )
      .run(fixture.organizationId, fixture.owner.id);
    fixture.database.exec(
      "UPDATE invitation SET status = 'canceled' WHERE id = 'seeded'",
    );
    expect(await fixture.events()).toEqual([]);
  });

  it("does not create the invitation when its history cannot be written", async () => {
    const fixture = await createMembershipFixture();
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect((await fixture.invite("dana@example.com", "admin")).status).toBe(
      500,
    );
    fixture.database.exec("DROP TRIGGER reject_activity");
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM invitation").get(),
    ).toEqual({ count: 0 });
  });
});

describe("organization update activity", () => {
  it("records renames with before and after values, and skips identical saves", async () => {
    const fixture = await createMembershipFixture();
    const update = (
      data: Record<string, unknown>,
      cookie = fixture.owner.cookie,
    ) =>
      post(
        fixture.auth,
        "/organization/update",
        { data, organizationId: fixture.organizationId },
        cookie,
      );
    const original = fixture.database
      .query("SELECT name, slug FROM organization WHERE id = ?")
      .get(fixture.organizationId) as { name: string; slug: string };
    expect(
      (await update({ name: "Renamed Org", slug: "renamed-org" })).status,
    ).toBe(200);
    expect(
      (await update({ name: "Renamed Org", slug: "renamed-org" })).status,
    ).toBe(200);
    expect(
      (await update({ name: "Denied" }, fixture.carol.cookie)).status,
    ).toBe(403);
    const events = await fixture.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "organization.updated",
      actor: { id: fixture.owner.id },
      details: {
        changes: [
          { after: "Renamed Org", before: original.name, field: "name" },
          { after: "renamed-org", before: original.slug, field: "slug" },
        ],
      },
      root: {
        id: fixture.organizationId,
        label: "Renamed Org",
        type: "organization",
      },
    });
    // Everyone in the organization sees its name change.
    expect(
      (await fixture.feed(fixture.carol.cookie)).map(({ action }) => action),
    ).toEqual(["organization.updated"]);
    expect(
      fixture.database
        .query("SELECT name, activity_actor_id FROM organization WHERE id = ?")
        .get(fixture.organizationId),
    ).toEqual({ activity_actor_id: null, name: "Renamed Org" });
  });

  it("keeps the old name when the history cannot be written", async () => {
    const fixture = await createMembershipFixture();
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const response = await post(
      fixture.auth,
      "/organization/update",
      { data: { name: "Renamed Org" }, organizationId: fixture.organizationId },
      fixture.owner.cookie,
    );
    expect(response.status).toBe(500);
    expect(
      fixture.database
        .query("SELECT name FROM organization WHERE id = ?")
        .get(fixture.organizationId),
    ).toEqual({ name: "Alice's Organization" });
  });
});

/**
 * Alice owns the organization; Bob is a member in its Finance group with a
 * laptop and an API key; Carol is a plain member.
 */
async function createMembershipFixture() {
  const fixture = await createFixture();
  const { auth, bindings, database } = fixture;
  async function person(userEmail: string, name: string) {
    // Each test signs up several people from one address.
    database.exec("DELETE FROM rateLimit");
    expect(
      (
        await post(auth, "/sign-up/email", {
          email: userEmail,
          name,
          password: originalPassword,
          termsAccepted: true,
        })
      ).status,
    ).toBe(200);
    const signIn = await post(auth, "/sign-in/email", {
      email: userEmail,
      password: originalPassword,
    });
    expect(signIn.status).toBe(200);
    const cookies = new CookieJar();
    cookies.absorb(signIn);
    const user = database
      .query(
        "SELECT id, defaultOrganizationId AS organizationId FROM user WHERE email = ?",
      )
      .get(userEmail) as { id: string; organizationId: string };
    return { ...user, cookie: cookies.header() };
  }
  const owner = await person(email, "Alice");
  const bob = await person("bob@example.com", "Bob");
  const carol = await person("carol@example.com", "Carol");
  const organizationId = owner.organizationId;
  const now = new Date().toISOString();
  database
    .query(
      "UPDATE member SET id = 'alice' WHERE userId = ? AND organizationId = ?",
    )
    .run(owner.id, organizationId);
  for (const [id, user] of [
    ["bob", bob],
    ["carol", carol],
  ] as const)
    database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES (?, ?, ?, 'member', ?)`)
      .run(id, organizationId, user.id, now);
  // Carol works in Alice's organization.
  database
    .query("UPDATE session SET activeOrganizationId = ? WHERE userId = ?")
    .run(organizationId, carol.id);
  const finance = database
    .query(`SELECT id FROM team WHERE organizationId = ?`)
    .get(organizationId) as { id: string };
  database
    .query(`INSERT INTO teamMember (id, teamId, userId, membershipKey, createdAt)
      VALUES ('bob-finance', ?, ?, NULL, ?)`)
    .run(finance.id, bob.id, now);
  database
    .query(`UPDATE team SET memberCount = 2 WHERE id = ?`)
    .run(finance.id);
  database
    .query(`INSERT INTO equipment (id, organization_id, type, make, model,
      assigned_user_id, created_at, updated_at)
      VALUES ('laptop', ?, 'laptop', 'Apple', 'MacBook', ?, ?, ?)`)
    .run(organizationId, bob.id, now, now);
  database
    .query(`INSERT INTO organization_api_keys (id, organization_id, name, access,
      token_prefix, token_hash, created_by, created_at)
      VALUES ('bob-key', ?, 'Bob''s key', 'read', 'bb_1', 'hash', ?, ?)`)
    .run(organizationId, bob.id, now);
  database
    .query(`INSERT INTO organization_api_keys (id, organization_id, name, access,
      token_prefix, token_hash, created_by, created_at, expires_at)
      VALUES ('bob-expired', ?, 'Expired', 'read', 'bb_2', 'hash-2', ?, ?,
              '2026-01-01T00:00:00.000Z')`)
    .run(organizationId, bob.id, now);
  insertBilling(database, organizationId, {
    seat_quantity: 10,
    stripe_event_created: 1,
    stripe_price_id: "price_pro_test",
    stripe_status: "active",
  });
  // Only what the tests do: seeding wrote activity of its own.
  const seeded = (
    database.query("SELECT MAX(id) AS id FROM activity_events").get() as {
      id: number;
    }
  ).id;
  return {
    ...fixture,
    bob,
    carol,
    organizationId,
    owner,
    person,
    events: async () =>
      (
        (
          await findActivity(
            bindings.DB,
            organizationId,
            undefined,
            undefined,
            true,
            undefined,
            true,
          )
        )?.events ?? []
      ).filter(({ id }) => id > seeded),
    feed: async (cookie: string) => {
      const response = await app.request(
        "/api/activity",
        { headers: { cookie } },
        bindings,
        executionContext(fixture.pending),
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        events: { action: string; id: number }[];
      };
      return page.events.filter(({ id }) => id > seeded);
    },
    invite: (inviteEmail: string, role: string, cookie = owner.cookie) =>
      post(
        auth,
        "/organization/invite-member",
        { email: inviteEmail, organizationId, role },
        cookie,
      ),
    remove: (memberId: string, cookie = owner.cookie) =>
      post(
        auth,
        "/organization/remove-member",
        { memberIdOrEmail: memberId, organizationId },
        cookie,
      ),
    state: () => ({
      financeMembers: (
        database
          .query(
            `SELECT userId FROM teamMember WHERE teamId = ? ORDER BY userId`,
          )
          .all(finance.id) as { userId: string }[]
      ).map(({ userId }) => userId),
      laptopAssignee: (
        database
          .query("SELECT assigned_user_id FROM equipment WHERE id = 'laptop'")
          .get() as { assigned_user_id: string | null }
      ).assigned_user_id,
      memberCount: (
        database
          .query("SELECT memberCount FROM team WHERE id = ?")
          .get(finance.id) as { memberCount: number }
      ).memberCount,
      members: (
        database
          .query("SELECT id FROM member WHERE organizationId = ? ORDER BY id")
          .all(organizationId) as { id: string }[]
      ).map(({ id }) => id),
    }),
  };
}
