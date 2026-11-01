import { describe, expect, it } from "bun:test";
import { adminOrganizations } from "../admin/adminOrganizations";
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
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { insertBilling } from "../testing/seed";
import { testApp } from "../testing/session";

const bobToken = `tlk_${"b".repeat(64)}`;

describe("API keys after their creator's access changes", () => {
  it("revokes a demoted creator's keys, and regaining the role does not restore them", async () => {
    const fixture = await createAccessFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    await fixture.insertBobKeys();
    expect(await fixture.useKey()).toBe(200);
    const before = fixture.lastEventId();

    expect((await fixture.changeRole("member")).status).toBe(200);
    expect(await fixture.useKey()).toBe(401);
    const events = await fixture.eventsSince(before);
    expect(events.map(({ action }) => action)).toEqual([
      "api_key.revoked",
      "organization.member_role_changed",
    ]);
    const [revoked, roleChange] = events;
    expect(roleChange).toMatchObject({
      actor: { id: fixture.owner.id, name: "Alice", email },
      details: {
        after: "member",
        before: "admin",
        // The expired key had already stopped and stays as it was.
        revokedApiKeys: [{ id: "bob-key", name: "Bob agent" }],
        userId: fixture.bob.id,
      },
    });
    expect(revoked).toMatchObject({
      actor: { id: fixture.owner.id, name: "Alice", email },
      details: {
        access: "write",
        prefix: "tlk_bbbbbbbb",
        reason: "role_changed",
      },
      root: { id: "bob-key", label: "Bob agent", type: "api_key" },
    });
    expect(fixture.keys()).toEqual([
      { id: "bob-expired", revoked_by: null, revoked_reason: null },
      {
        id: "bob-key",
        revoked_by: fixture.owner.id,
        revoked_reason: "role_changed",
      },
    ]);

    // Promoting Bob again records the role change and nothing about keys.
    const promoted = fixture.lastEventId();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    expect(await fixture.useKey()).toBe(401);
    expect(
      (await fixture.eventsSince(promoted)).map(({ action, details }) => [
        action,
        details.revokedApiKeys,
      ]),
    ).toEqual([["organization.member_role_changed", []]]);

    // The key's own history shows its end; every member can read it.
    const keyHistory = await app.request(
      "/api/activity?resourceType=api_key",
      { headers: { cookie: fixture.carol.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(keyHistory.status).toBe(200);
    expect(
      (
        (await keyHistory.json()) as {
          events: { action: string; root: { id: string } }[];
        }
      ).events
        .filter(({ root }) => root.id === "bob-key")
        .map(({ action }) => action),
    ).toEqual(["api_key.revoked", "api_key.created"]);

    // The API keys page says who revoked it and why.
    const listing = await app.request(
      "/api/organization-settings/api-keys",
      { headers: { cookie: fixture.owner.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(listing.status).toBe(200);
    expect(
      (
        (await listing.json()) as { apiKeys: Record<string, unknown>[] }
      ).apiKeys.find(({ id }) => id === "bob-key"),
    ).toMatchObject({
      revokedBy: { id: fixture.owner.id },
      revokedReason: "role_changed",
      status: "revoked",
    });
    await Promise.all(fixture.pending);
  });

  it("revokes nothing for changes that keep owner or admin, unchanged roles, or refused changes", async () => {
    const fixture = await createAccessFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    await fixture.insertBobKeys();
    const before = fixture.lastEventId();
    expect((await fixture.changeRole("owner")).status).toBe(200);
    expect((await fixture.changeRole("owner")).status).toBe(200);
    expect((await fixture.changeRole("admin")).status).toBe(200);
    // Carol may not change roles.
    expect(
      (await fixture.changeRole("member", fixture.carol.cookie)).status,
    ).toBe(403);
    expect(await fixture.useKey()).toBe(200);
    expect(
      (await fixture.eventsSince(before)).map(({ action, details }) => [
        action,
        details.revokedApiKeys,
      ]),
    ).toEqual([
      ["organization.member_role_changed", []],
      ["organization.member_role_changed", []],
    ]);
    expect(fixture.keys().every(({ revoked_by }) => revoked_by === null)).toBe(
      true,
    );
  });

  it("keeps the role and key when the key's revocation cannot be recorded", async () => {
    const fixture = await createAccessFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    await fixture.insertBobKeys();
    const before = fixture.lastEventId();
    fixture.database.exec(`CREATE TRIGGER reject_key_activity
      BEFORE INSERT ON activity_events WHEN NEW.action = 'api_key.revoked'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect((await fixture.changeRole("member")).status).toBe(500);
    expect(fixture.bobRole()).toBe("admin");
    expect(fixture.keys().every(({ revoked_by }) => revoked_by === null)).toBe(
      true,
    );
    expect(await fixture.eventsSince(before)).toEqual([]);
    fixture.database.exec("DROP TRIGGER reject_key_activity");
    expect(await fixture.useKey()).toBe(200);
  });

  it("revokes a removed creator's keys, and rejoining as an admin does not restore them", async () => {
    const fixture = await createAccessFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    await fixture.insertBobKeys();
    expect((await fixture.remove("bob", fixture.carol.cookie)).status).not.toBe(
      200,
    );
    expect(await fixture.useKey()).toBe(200);

    expect((await fixture.remove("bob")).status).toBe(200);
    expect(await fixture.useKey()).toBe(401);
    expect(fixture.keys()).toEqual([
      { id: "bob-expired", revoked_by: null, revoked_reason: null },
      {
        id: "bob-key",
        revoked_by: fixture.owner.id,
        revoked_reason: "member_removed",
      },
    ]);

    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: "bob@example.com",
        organizationId: fixture.organizationId,
        role: "admin",
      },
      fixture.owner.cookie,
    );
    expect(invite.status).toBe(200);
    const { id: invitationId } = (await invite.json()) as { id: string };
    const rejoined = fixture.lastEventId();
    expect(
      (
        await post(
          fixture.auth,
          "/organization/accept-invitation",
          { invitationId },
          fixture.bob.cookie,
        )
      ).status,
    ).toBe(200);
    expect(fixture.bobRole()).toBe("admin");
    expect(await fixture.useKey()).toBe(401);
    expect(
      (await fixture.eventsSince(rejoined)).map(({ action }) => action),
    ).toEqual([
      "organization.invitation_accepted",
      "organization.member_joined",
    ]);
    await Promise.all(fixture.pending);
  });

  it("keeps the membership and keys when a removal's key revocation cannot be recorded", async () => {
    const fixture = await createAccessFixture();
    expect((await fixture.changeRole("admin")).status).toBe(200);
    await fixture.insertBobKeys();
    const before = fixture.lastEventId();
    fixture.database.exec(`CREATE TRIGGER reject_key_activity
      BEFORE INSERT ON activity_events WHEN NEW.action = 'api_key.revoked'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect((await fixture.remove("bob")).status).toBe(500);
    expect(fixture.bobRole()).toBe("admin");
    expect(await fixture.eventsSince(before)).toEqual([]);
    fixture.database.exec("DROP TRIGGER reject_key_activity");
    expect(await fixture.useKey()).toBe(200);
  });

  it("revokes keys that had already stopped when the migration runs, naming no revoker", () => {
    const database = createTestDatabase({ before: "0085" });
    const now = new Date().toISOString();
    database.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('admin', 'Ada', 'ada@example.com', 1, '${now}', '${now}'),
             ('member', 'Max', 'max@example.com', 1, '${now}', '${now}'),
             ('gone', 'Gil', 'gil@example.com', 1, '${now}', '${now}')`);
    database.exec(`INSERT INTO organization (id, name, slug, createdAt)
      VALUES ('org', 'Org', 'org', '${now}')`);
    database.exec(`INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('m-admin', 'org', 'admin', 'member, admin', '${now}'),
             ('m-member', 'org', 'member', 'member', '${now}')`);
    const key = (id: string, creator: string, extra = "NULL, NULL, NULL") =>
      database.exec(`INSERT INTO organization_api_keys (id, organization_id,
        name, access, token_prefix, token_hash, created_by, created_at,
        expires_at, revoked_at, revoked_by)
        VALUES ('${id}', 'org', '${id}', 'read', 'p', '${id}-hash',
                '${creator}', '${now}', ${extra})`);
    key("active", "admin");
    key("demoted", "member");
    key("left", "gone");
    key("expired", "member", "'2026-01-01T00:00:00.000Z', NULL, NULL");
    key("revoked", "member", `NULL, '${now}', 'admin'`);
    database.exec(`INSERT INTO user_security_events (user_id, action, occurred_at)
      VALUES ('member', 'password_changed', '${now}')`);
    const activity = () =>
      database.query("SELECT COUNT(*) AS count FROM activity_events").get();
    const recorded = activity();

    applyMigrations(database, { from: "0085" });
    expect(
      database
        .query(
          `SELECT id, revoked_at IS NOT NULL AS revoked, revoked_by, revoked_reason
           FROM organization_api_keys ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "active", revoked: 0, revoked_by: null, revoked_reason: null },
      {
        id: "demoted",
        revoked: 1,
        revoked_by: null,
        revoked_reason: "creator_access_ended",
      },
      { id: "expired", revoked: 0, revoked_by: null, revoked_reason: null },
      {
        id: "left",
        revoked: 1,
        revoked_by: null,
        revoked_reason: "creator_access_ended",
      },
      { id: "revoked", revoked: 1, revoked_by: "admin", revoked_reason: null },
    ]);
    // No actor made these revocations, so none is recorded.
    expect(activity()).toEqual(recorded);
    expect(
      database
        .query("SELECT user_id, action, details FROM user_security_events")
        .all(),
    ).toEqual([
      { user_id: "member", action: "password_changed", details: null },
    ]);
  });
});

describe("organization creation activity", () => {
  it("records sign-up and later creation with the founding owner, for members and root admins", async () => {
    const fixture = await createAccessFixture();
    const signUp = await findActivity(
      fixture.bindings.DB,
      fixture.organizationId,
      undefined,
      undefined,
      false,
      "organization",
    );
    expect(signUp?.events).toHaveLength(1);
    expect(signUp?.events[0]).toMatchObject({
      action: "organization.created",
      actor: { id: fixture.owner.id, name: "Alice", email },
      details: {
        name: "Alice's Organization",
        ownerEmail: email,
        ownerId: fixture.owner.id,
        ownerName: "Alice",
        slug: `personal-${fixture.owner.id.toLowerCase()}`,
        via: "signup",
      },
      root: { id: fixture.organizationId, type: "organization" },
    });
    // Every member reads it, as they read renames.
    const memberFeed = await app.request(
      "/api/activity?resourceType=organization",
      { headers: { cookie: fixture.carol.cookie } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(
      (
        (await memberFeed.json()) as { events: { action: string }[] }
      ).events.map(({ action }) => action),
    ).toEqual(["organization.created"]);

    const created = await post(
      fixture.auth,
      "/organization/create",
      {
        name: "Second",
        slug: "second-org",
        activityActorId: fixture.carol.id,
        activityCreatedVia: "signup",
      },
      fixture.owner.cookie,
    );
    expect(created.status).toBe(200);
    const { id: secondId } = (await created.json()) as { id: string };
    expect(
      fixture.database
        .query(
          "SELECT activity_actor_id, activity_created_via FROM organization WHERE id = ?",
        )
        .get(secondId),
    ).toEqual({ activity_actor_id: null, activity_created_via: null });
    const admin = testApp(
      { "/": adminOrganizations },
      {
        email: "root@example.com",
        name: "Root",
        role: "admin",
        userId: "root",
      },
    );
    const adminPage = await admin.request(
      `/${secondId}/activity`,
      undefined,
      testBindings({ DB: toD1(fixture.database) }),
    );
    expect(adminPage.status).toBe(200);
    expect(
      ((await adminPage.json()) as { events: unknown[] }).events,
    ).toMatchObject([
      {
        action: "organization.created",
        actor: { id: fixture.owner.id },
        details: {
          name: "Second",
          ownerId: fixture.owner.id,
          slug: "second-org",
          via: "create",
        },
      },
    ]);
    await Promise.all(fixture.pending);
  });

  it("records nothing when creating the organization fails", async () => {
    const fixture = await createFixture();
    const events = () =>
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE action = 'organization.created'",
        )
        .get();
    // Provisioning removes the organization when its owner cannot be added.
    fixture.database.exec(`CREATE TRIGGER reject_member BEFORE INSERT ON member
      BEGIN SELECT RAISE(ABORT, 'members unavailable'); END`);
    expect(
      (
        await post(fixture.auth, "/sign-up/email", {
          email,
          name: "Alice",
          password: originalPassword,
          termsAccepted: true,
        })
      ).status,
    ).not.toBe(200);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM organization")
        .get(),
    ).toEqual({ count: 0 });
    expect(events()).toEqual({ count: 0 });
    fixture.database.exec("DROP TRIGGER reject_member");

    // A creation whose history cannot be written does not happen.
    fixture.database.exec("DELETE FROM rateLimit");
    const cookies = new CookieJar();
    const second = "second@example.com";
    expect(
      (
        await post(fixture.auth, "/sign-up/email", {
          email: second,
          name: "Second",
          password: originalPassword,
          termsAccepted: true,
        })
      ).status,
    ).toBe(200);
    cookies.absorb(
      await post(fixture.auth, "/sign-in/email", {
        email: second,
        password: originalPassword,
      }),
    );
    fixture.database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect(
      (
        await post(
          fixture.auth,
          "/organization/create",
          { name: "Second", slug: "second-org" },
          cookies.header(),
        )
      ).status,
    ).toBe(500);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM organization WHERE slug = 'second-org'",
        )
        .get(),
    ).toEqual({ count: 0 });
    fixture.database.exec("DROP TRIGGER reject_activity");
    expect(events()).toEqual({ count: 1 });
  });
});

/**
 * Alice owns the organization; Bob and Carol are members, each with an
 * organization of their own from signing up.
 */
async function createAccessFixture() {
  const fixture = await createFixture();
  const { auth, bindings, database } = fixture;
  async function person(userEmail: string, name: string) {
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
      .query("SELECT id FROM user WHERE email = ?")
      .get(userEmail) as { id: string };
    return { ...user, cookie: cookies.header() };
  }
  const owner = await person(email, "Alice");
  const bob = await person("bob@example.com", "Bob");
  const carol = await person("carol@example.com", "Carol");
  const organizationId = (
    database
      .query("SELECT defaultOrganizationId AS id FROM user WHERE id = ?")
      .get(owner.id) as { id: string }
  ).id;
  const now = new Date().toISOString();
  for (const [id, user] of [
    ["bob", bob],
    ["carol", carol],
  ] as const)
    database
      .query(`INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES (?, ?, ?, 'member', ?)`)
      .run(id, organizationId, user.id, now);
  database
    .query("UPDATE session SET activeOrganizationId = ? WHERE userId <> ?")
    .run(organizationId, owner.id);
  insertBilling(database, organizationId, {
    seat_quantity: 10,
    stripe_event_created: 1,
    stripe_price_id: "price_pro_test",
    stripe_status: "active",
  });
  const lastEventId = () =>
    (
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
    lastEventId,
    bobRole: () =>
      (
        database
          .query(
            "SELECT role FROM member WHERE userId = ? AND organizationId = ?",
          )
          .get(bob.id, organizationId) as { role: string } | null
      )?.role,
    changeRole: (role: string, cookie = owner.cookie) =>
      post(
        auth,
        "/organization/update-member-role",
        { memberId: "bob", organizationId, role },
        cookie,
      ),
    eventsSince: async (id: number) =>
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
      ).filter((event) => event.id > id),
    async insertBobKeys() {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(bobToken),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      database
        .query(`INSERT INTO organization_api_keys (id, organization_id, name,
          access, token_prefix, token_hash, created_by, created_at)
          VALUES ('bob-key', ?, 'Bob agent', 'write', 'tlk_bbbbbbbb', ?, ?, ?)`)
        .run(organizationId, hash, bob.id, new Date().toISOString());
      database
        .query(`INSERT INTO organization_api_keys (id, organization_id, name,
          access, token_prefix, token_hash, created_by, created_at, expires_at)
          VALUES ('bob-expired', ?, 'Expired', 'read', 'tlk_cccccccc', 'old', ?,
                  ?, '2026-01-01T00:00:00.000Z')`)
        .run(organizationId, bob.id, new Date().toISOString());
    },
    keys: () =>
      database
        .query(
          `SELECT id, revoked_by, revoked_reason FROM organization_api_keys
           ORDER BY id`,
        )
        .all() as {
        id: string;
        revoked_by: string | null;
        revoked_reason: string | null;
      }[],
    remove: (memberId: string, cookie = owner.cookie) =>
      post(
        auth,
        "/organization/remove-member",
        { memberIdOrEmail: memberId, organizationId },
        cookie,
      ),
    async useKey() {
      const response = await app.request(
        "/api/me",
        { headers: { authorization: `Bearer ${bobToken}` } },
        bindings,
        executionContext(fixture.pending),
      );
      return response.status;
    },
  };
}
