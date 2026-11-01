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

describe("organization role activity", () => {
  it("records the actor, affected user, role transition and time in the organization's feed", async () => {
    const fixture = await createRoleActivityFixture();
    const startedAt = Date.now();
    const response = await fixture.changeRole("admin");
    expect(response.status).toBe(200);
    const page = await fixture.history();
    expect(page?.events).toHaveLength(1);
    expect(page?.events[0]).toMatchObject({
      action: "organization.member_role_changed",
      actor: { id: fixture.owner.id, name: "Alice", email },
      details: {
        before: "member",
        after: "admin",
        userId: fixture.target.id,
        userName: "Bob",
        userEmail: "bob@example.com",
      },
      historical: false,
      root: { type: "organization_member", id: "bob-member", label: "Bob" },
      subject: { type: "organization_member", id: "bob-member" },
    });
    const occurredAt = Date.parse(page?.events[0]?.occurredAt ?? "");
    expect(occurredAt).toBeGreaterThanOrEqual(startedAt);
    expect(occurredAt).toBeLessThanOrEqual(Date.now());
    expect(fixture.member()).toEqual({
      role: "admin",
      activity_actor_id: null,
    });

    const feed = await app.request(
      "/api/activity?resourceType=organization_member",
      { headers: { cookie: fixture.owner.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({
      events: page?.events,
      nextCursor: null,
    });
    // Signing up created the Finance group; its owner sees that grant.
    const groups = await app.request(
      "/api/activity?resourceType=organization_group",
      { headers: { cookie: fixture.owner.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(await groups.json()).toMatchObject({
      events: [
        {
          action: "organization.group_created",
          actor: { id: fixture.owner.id },
          details: {
            capabilities: ["finance"],
            members: [{ userId: fixture.owner.id }],
            name: "Finance",
          },
          root: { label: "Finance", type: "organization_group" },
        },
      ],
    });
    const otherFeed = await app.request(
      "/api/activity?resourceType=organization_member",
      { headers: { cookie: fixture.target.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(otherFeed.status).toBe(200);
    expect(await otherFeed.json()).toMatchObject({ events: [] });
    await Promise.all(fixture.pending);
  });

  it("does not log unchanged roles or attribute later maintenance to a stale actor", async () => {
    const fixture = await createRoleActivityFixture();
    expect((await fixture.changeRole("member")).status).toBe(200);
    expect((await fixture.history())?.events).toHaveLength(0);
    expect((await fixture.changeRole("admin")).status).toBe(200);
    expect((await fixture.changeRole("admin")).status).toBe(200);
    fixture.database.exec(
      "UPDATE member SET role = 'member' WHERE id = 'bob-member'",
    );
    expect((await fixture.history())?.events).toHaveLength(1);
    expect(fixture.member()).toEqual({
      role: "member",
      activity_actor_id: null,
    });
  });

  it("keeps permission, organization and last-owner checks without logging rejected attempts", async () => {
    const fixture = await createRoleActivityFixture();
    expect(
      (await fixture.changeRole("owner", fixture.target.cookie)).status,
    ).toBe(403);
    expect((await fixture.changeRole("invalid-role")).status).toBe(400);
    const lastOwner = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: fixture.owner.memberId,
        organizationId: fixture.owner.organizationId,
        role: "member",
      },
      fixture.owner.cookie,
    );
    expect(lastOwner.status).toBe(400);
    const wrongOrganization = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: "bob-member",
        organizationId: fixture.target.organizationId,
        role: "admin",
      },
      fixture.target.cookie,
    );
    expect(wrongOrganization.status).toBe(403);
    expect((await fixture.changeRole("admin", "")).status).toBe(401);
    expect((await fixture.history())?.events).toHaveLength(0);
    expect(fixture.member()?.role).toBe("member");
  });

  it("rolls back the role change when the activity insert fails", async () => {
    const fixture = await createRoleActivityFixture();
    fixture.database.exec(`CREATE TRIGGER reject_role_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const response = await fixture.changeRole("admin");
    expect(response.status).toBe(500);
    expect(fixture.member()).toEqual({
      role: "member",
      activity_actor_id: null,
    });
    expect((await fixture.history())?.events).toHaveLength(0);
    fixture.database.exec("DROP TRIGGER reject_role_activity");
    expect((await fixture.changeRole("admin")).status).toBe(200);
    expect((await fixture.history())?.events).toHaveLength(1);
  });

  it("uses the authenticated actor for HTTP and direct API calls, ignoring supplied attribution", async () => {
    const fixture = await createRoleActivityFixture();
    const response = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: "bob-member",
        organizationId: fixture.owner.organizationId,
        role: "admin",
        activityActorId: fixture.target.id,
        activity_actor_id: fixture.target.id,
      },
      fixture.owner.cookie,
    );
    expect(response.status).toBe(200);
    const changed = await fixture.auth.api.updateMemberRole({
      body: {
        memberId: "bob-member",
        organizationId: fixture.owner.organizationId,
        role: ["admin", "owner"],
      },
      headers: new Headers({ cookie: fixture.owner.cookie }),
    });
    expect(changed).toMatchObject({ role: "admin,owner" });
    const events = (await fixture.history())?.events ?? [];
    expect(events).toHaveLength(2);
    expect(events.map(({ actor }) => actor.id)).toEqual([
      fixture.owner.id,
      fixture.owner.id,
    ]);
    expect(events[0]?.details).toMatchObject({
      before: "admin",
      after: "admin,owner",
    });
  });

  it("keeps identity snapshots and history after renames and membership removal", async () => {
    const fixture = await createRoleActivityFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    fixture.database
      .query("UPDATE user SET name = 'Renamed', email = ? WHERE id = ?")
      .run("renamed@example.com", fixture.target.id);
    fixture.database
      .query("UPDATE user SET name = 'Renamed actor' WHERE id = ?")
      .run(fixture.owner.id);
    fixture.database.exec("DELETE FROM member WHERE id = 'bob-member'");
    expect((await fixture.history())?.events[0]).toMatchObject({
      actor: { name: "Alice", email },
      details: { userName: "Bob", userEmail: "bob@example.com" },
      root: { label: "Bob" },
    });
  });

  it("uses the committed previous role and request actor for concurrent changes", async () => {
    const fixture = await createRoleActivityFixture();
    fixture.database.exec(
      "UPDATE member SET role = 'owner' WHERE id = 'bob-member'",
    );
    // Use a third member so both actors retain permission during the race.
    fixture.database.exec(`INSERT INTO user
      (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('third-user', 'Charlie', 'charlie@example.com', 1,
              '2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z')`);
    fixture.database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('third-member', ?, 'third-user', 'member', '2026-10-15T12:00:00Z')`)
      .run(fixture.owner.organizationId);
    const responses = await Promise.all([
      fixture.changeRole("admin", fixture.owner.cookie, "third-member"),
      fixture.changeRole("owner", fixture.target.cookie, "third-member"),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const events =
      (await fixture.history())?.events
        .toReversed()
        .map(({ actor, details: { before, after } }) => ({
          actor,
          before,
          after,
        })) ?? [];
    expect(events).toHaveLength(2);
    expect(events[0]?.before).toBe("member");
    expect(events[1]?.before).toBe(events[0]?.after);
    expect(events.find((event) => event.after === "admin")?.actor.id).toBe(
      fixture.owner.id,
    );
    expect(events.find((event) => event.after === "owner")?.actor.id).toBe(
      fixture.target.id,
    );
  });
});

async function createRoleActivityFixture() {
  const fixture = await createFixture();
  const { auth, bindings } = fixture;
  async function person(userEmail: string, name: string) {
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
    const user = fixture.database
      .query(`SELECT user.id, user.defaultOrganizationId AS organizationId,
      member.id AS memberId FROM user JOIN member ON member.userId = user.id
      AND member.organizationId = user.defaultOrganizationId WHERE user.email = ?`)
      .get(userEmail) as {
      id: string;
      organizationId: string;
      memberId: string;
    };
    return { ...user, cookie: cookies.header() };
  }
  const owner = await person(email, "Alice");
  const target = await person("bob@example.com", "Bob");
  fixture.database
    .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
    VALUES ('bob-member', ?, ?, 'member', ?)`)
    .run(owner.organizationId, target.id, new Date().toISOString());
  insertBilling(fixture.database, owner.organizationId, {
    seat_quantity: 3,
    stripe_price_id: "price_pro_test",
    stripe_status: "active",
  });
  return {
    ...fixture,
    auth,
    bindings,
    owner,
    target,
    changeRole: (
      role: string,
      cookie = owner.cookie,
      memberId = "bob-member",
    ) =>
      post(
        auth,
        "/organization/update-member-role",
        {
          memberId,
          organizationId: owner.organizationId,
          role,
        },
        cookie,
      ),
    // Sign-up recorded the organization's creation; these tests read roles.
    history: () =>
      findActivity(
        bindings.DB,
        owner.organizationId,
        undefined,
        undefined,
        false,
        "organization_member",
      ),
    member: () =>
      fixture.database
        .query(
          "SELECT role, activity_actor_id FROM member WHERE id = 'bob-member'",
        )
        .get() as { role: string; activity_actor_id: string | null } | null,
  };
}
