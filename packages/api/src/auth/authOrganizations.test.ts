import { describe, expect, it } from "bun:test";
import { app } from "../app";
import {
  baseURL,
  createFixture,
  email,
  executionContext,
  financeGroupFor,
  get,
  origin,
  originalPassword,
  post,
} from "../testing/authFixture";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { insertBilling, seedUser } from "../testing/seed";

describe("organizations", () => {
  it("only lets owners rename their organization", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const organization = fixture.database
      .query("SELECT id FROM organization")
      .get() as { id: string };
    await post(fixture.auth, "/sign-up/email", {
      email: "other@example.com",
      name: "Other Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email: "other@example.com",
      password: originalPassword,
    });

    const response = await post(
      fixture.auth,
      "/organization/update",
      {
        data: { name: "Not Allowed" },
        organizationId: organization.id,
      },
      signIn.headers.get("set-cookie"),
    );

    expect(response.status).toBe(400);
    expect(
      fixture.database
        .query("SELECT name FROM organization WHERE id = ?")
        .get(organization.id),
    ).toEqual({ name: "Example Person's Organization" });
  });

  it("keeps Free organizations to one user", async () => {
    const fixture = await createFixture();
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
    const organization = fixture.database
      .query(`SELECT defaultOrganizationId AS id FROM user WHERE email = ?`)
      .get(email) as { id: string };
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: "second@example.com",
        organizationId: organization.id,
        role: "member",
      },
      signIn.headers.get("set-cookie"),
    );
    expect(invite.status).toBe(403);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM invitation
           WHERE organizationId = ?`,
        )
        .get(organization.id),
    ).toEqual({ count: 0 });
  });

  it("rejects a pending Pro invitation after downgrade to Free", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const organization = fixture.database
      .query(`SELECT defaultOrganizationId AS id FROM user WHERE email = ?`)
      .get(email) as { id: string };
    insertBilling(fixture.database, organization.id, {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: "price_pro_test",
      stripe_status: "active",
    });
    const invitedEmail = "downgraded-invitee@example.com";
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
      },
      ownerSignIn.headers.get("set-cookie"),
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    fixture.database
      .query(
        `UPDATE organization_billing SET stripe_status = 'canceled',
         updated_at = ? WHERE organization_id = ?`,
      )
      .run(new Date().toISOString(), organization.id);

    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: invitation.id },
      inviteeSignIn.headers.get("set-cookie"),
    );

    expect(accepted.status).toBe(403);
    expect(
      fixture.database
        .query(
          `SELECT invitation.status,
                  (SELECT COUNT(*) FROM member
                   JOIN user ON user.id = member.userId
                   WHERE member.organizationId = invitation.organizationId
                     AND user.email = invitation.email) AS memberCount
           FROM invitation WHERE invitation.id = ?`,
        )
        .get(invitation.id),
    ).toEqual({ memberCount: 0, status: "pending" });
  });

  it("renews a pending invitation, keeping its forms and emailing the new link", async () => {
    const fixture = await createFixture();
    const { organization, ownerCookie } = await proOrganizationOwner(fixture);
    const invitedEmail = "invitee@example.com";

    const firstInvite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
      },
      ownerCookie,
    );
    expect(firstInvite.status).toBe(200);
    const firstInvitation = (await firstInvite.json()) as { id: string };
    fixture.database
      .query(`INSERT INTO employee_requirements
        (id, organization_id, invitation_id, target_email, kind, title,
         due_date, created_at, updated_at)
        VALUES ('renewed-form', ?, ?, ?, 'form', 'W-4', '2026-10-01', ?, ?)`)
      .run(
        organization.id,
        firstInvitation.id,
        invitedEmail,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "admin",
      },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    await Promise.all(fixture.pending);
    expect(
      fixture.database
        .query("SELECT status FROM invitation WHERE id = ?")
        .get(firstInvitation.id),
    ).toEqual({ status: "canceled" });
    expect(
      fixture.database
        .query(
          "SELECT invitation_id FROM employee_requirements WHERE id = 'renewed-form'",
        )
        .get(),
    ).toEqual({ invitation_id: invitation.id });
    expect(
      fixture.messages.filter(({ subject }) => subject.startsWith("You're")),
    ).toMatchObject({
      length: 2,
    });
    const invitationMessage = fixture.messages
      .filter(({ subject }) => subject.startsWith("You're"))
      .at(-1);
    expect(invitationMessage).toMatchObject({
      subject: `You're invited to ${organization.name}`,
      to: invitedEmail,
    });
    expect(invitationMessage?.text).toContain(
      `${origin}/invite?id=${invitation.id}`,
    );
    expect(invitationMessage?.text).toContain("with the admin role");
  });

  it("transfers an invitation's forms when the invitee accepts after sign-up", async () => {
    const fixture = await createFixture();
    const { organization, ownerCookie } = await proOrganizationOwner(fixture);
    const invitedEmail = "invitee@example.com";

    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "admin",
      },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    fixture.database
      .query(`INSERT INTO employee_requirements
        (id, organization_id, invitation_id, target_email, kind, title,
         due_date, created_at, updated_at)
        VALUES ('renewed-form', ?, ?, ?, 'form', 'W-4', '2026-10-01', ?, ?)`)
      .run(
        organization.id,
        invitation.id,
        invitedEmail,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    await Promise.all(fixture.pending);

    const inviteeSignUp = await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(inviteeSignUp.status).toBe(200);
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
    expect(inviteeCookie).toContain("better-auth.session_token=");
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: invitation.id },
      inviteeCookie,
    );
    expect(accepted.status).toBe(200);

    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count
           FROM member
           JOIN user ON user.id = member.userId
           WHERE user.email = ?`,
        )
        .get(invitedEmail),
    ).toEqual({ count: 2 });
    const invitedMember = fixture.database
      .query(
        `SELECT member.id, member.role
         FROM member
         JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId = ?`,
      )
      .get(invitedEmail, organization.id) as { id: string; role: string };
    expect(invitedMember.role).toBe("admin");
    expect(
      fixture.database
        .query(
          "SELECT member_id, invitation_id FROM employee_requirements WHERE id = 'renewed-form'",
        )
        .get(),
    ).toEqual({ member_id: invitedMember.id, invitation_id: null });
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId, invitation.status
           FROM user JOIN invitation ON invitation.email = user.email
           WHERE user.email = ? AND invitation.id = ?`,
        )
        .get(invitedEmail, invitation.id),
    ).toEqual({
      defaultOrganizationId: organization.id,
      status: "accepted",
    });
    const session = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: inviteeCookie ?? "", origin },
      }),
    );
    expect(await session.json()).toMatchObject({
      session: { activeOrganizationId: organization.id },
      user: { defaultOrganizationId: organization.id },
    });
  });

  it("keeps group access out of invitations", async () => {
    const fixture = await createFixture();
    const { organization, ownerCookie } = await proOrganizationOwner(fixture);
    const { teamId } = fixture.database
      .query('SELECT id AS teamId FROM "team" WHERE "organizationId" = ?')
      .get(organization.id) as { teamId: string };
    const invitedEmail = "invitee@example.com";
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
        teamId,
      },
      ownerCookie,
    );
    expect(invite.status).toBe(400);
    const invitations = () =>
      fixture.database
        .query('SELECT id, "teamId" FROM invitation WHERE email = ?')
        .all(invitedEmail);
    expect(invitations()).toEqual([]);

    // An invitation saved with a group before this rule grants no access.
    const owner = fixture.database
      .query("SELECT id FROM user WHERE email = ?")
      .get(email) as { id: string };
    fixture.database
      .query(
        `INSERT INTO invitation
         (id, organizationId, email, role, status, expiresAt, createdAt,
          inviterId, "teamId")
         VALUES ('legacy-invitation', ?, ?, 'member', 'pending', ?, ?, ?, ?)`,
      )
      .run(
        organization.id,
        invitedEmail,
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
        owner.id,
        teamId,
      );
    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: "legacy-invitation" },
      inviteeSignIn.headers.get("set-cookie"),
    );
    expect(accepted.status).toBe(200);
    await Promise.all(fixture.pending);
    expect(
      fixture.database
        .query(
          `SELECT member.role, "teamMember"."teamId" AS team_id
           FROM member JOIN user ON user.id = member.userId
           LEFT JOIN "teamMember"
             ON "teamMember"."userId" = user.id AND "teamMember"."teamId" = ?
           WHERE user.email = ? AND member.organizationId = ?`,
        )
        .all(teamId, invitedEmail, organization.id),
    ).toEqual([{ role: "member", team_id: null }]);
    expect(invitations()).toEqual([{ id: "legacy-invitation", teamId: null }]);
  });

  it("lets the owner, but not an invited admin, change roles", async () => {
    const fixture = await createFixture();
    const { invitedEmail, inviteeCookie, organization, ownerCookie } =
      await invitedAdmin(fixture);
    const invitedMember = fixture.database
      .query(
        `SELECT member.id, member.role
         FROM member
         JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId = ?`,
      )
      .get(invitedEmail, organization.id) as { id: string; role: string };
    const ownerMember = fixture.database
      .query(
        `SELECT member.id
         FROM member
         JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId = ?`,
      )
      .get(email, organization.id) as { id: string };
    const adminUpdatingOwner = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: ownerMember.id,
        organizationId: organization.id,
        role: "member",
      },
      inviteeCookie,
    );
    expect(adminUpdatingOwner.status).toBe(403);
    const ownerUpdatingAdmin = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: invitedMember.id,
        organizationId: organization.id,
        role: "member",
      },
      ownerCookie,
    );
    expect(ownerUpdatingAdmin.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT role FROM member WHERE id = ?")
        .get(invitedMember.id),
    ).toEqual({ role: "member" });
  });

  it("keeps the accepted organization as the default while sessions switch", async () => {
    const fixture = await createFixture();
    const { invitedEmail, inviteeCookie, organization } =
      await invitedAdmin(fixture);
    const personalOrganization = fixture.database
      .query(
        `SELECT member.organizationId AS id
         FROM member JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId != ?`,
      )
      .get(invitedEmail, organization.id) as { id: string };
    const switched = await post(
      fixture.auth,
      "/organization/set-active",
      { organizationId: personalOrganization.id },
      inviteeCookie,
    );
    expect(switched.status).toBe(200);
    const switchedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: inviteeCookie ?? "", origin },
      }),
    );
    expect(await switchedSession.json()).toMatchObject({
      session: { activeOrganizationId: personalOrganization.id },
      user: { defaultOrganizationId: organization.id },
    });

    const secondarySignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const secondaryCookie = secondarySignIn.headers.get("set-cookie");
    expect(
      await (await get(fixture.auth, "/get-session", secondaryCookie)).json(),
    ).toMatchObject({
      session: { activeOrganizationId: organization.id },
    });
    expect(
      (
        await post(
          fixture.auth,
          "/organization/set-active",
          { organizationId: organization.id },
          inviteeCookie,
        )
      ).status,
    ).toBe(200);
  });

  it("returns a member who leaves to their personal organization", async () => {
    const fixture = await createFixture();
    const { invitedEmail, inviteeCookie, organization } =
      await invitedAdmin(fixture);
    const personalOrganization = fixture.database
      .query(
        `SELECT member.organizationId AS id
         FROM member JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId != ?`,
      )
      .get(invitedEmail, organization.id) as { id: string };
    await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });

    const leave = await post(
      fixture.auth,
      "/organization/leave",
      { organizationId: organization.id },
      inviteeCookie,
    );
    expect(leave.status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId,
                  (SELECT COUNT(*) FROM member
                   WHERE member.userId = user.id) AS membershipCount
           FROM user WHERE user.email = ?`,
        )
        .get(invitedEmail),
    ).toEqual({
      defaultOrganizationId: personalOrganization.id,
      membershipCount: 1,
    });
    expect(
      fixture.database
        .query(
          `SELECT session.activeOrganizationId
           FROM session JOIN user ON user.id = session.userId
           WHERE user.email = ?
           ORDER BY session.activeOrganizationId`,
        )
        .all(invitedEmail),
    ).toEqual([
      { activeOrganizationId: null },
      { activeOrganizationId: personalOrganization.id },
    ]);
    expect(
      (
        await post(
          fixture.auth,
          "/organization/set-active",
          { organizationId: personalOrganization.id },
          inviteeCookie,
        )
      ).status,
    ).toBe(200);
  });

  it("lets a user create and activate another organization", async () => {
    const fixture = await createFixture();
    const signUp = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const cookie = signIn.headers.get("set-cookie");
    const created = await post(
      fixture.auth,
      "/organization/create",
      { name: "Field Operations", slug: "field-operations-12345678" },
      cookie,
    );
    expect(created.status).toBe(200);
    const organization = (await created.json()) as { id: string };
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId,
                  (SELECT COUNT(*) FROM member
                   WHERE member.userId = user.id) AS membershipCount
           FROM user WHERE user.email = ?`,
        )
        .get(email),
    ).toEqual({
      defaultOrganizationId: organization.id,
      membershipCount: 2,
    });
    expect(
      await (await get(fixture.auth, "/get-session", cookie)).json(),
    ).toMatchObject({
      session: { activeOrganizationId: organization.id },
    });
    expect(financeGroupFor(fixture.database, organization.id)).toMatchObject({
      capability: "finance",
      memberCount: 1,
      name: "Finance",
    });
    fixture.database
      .query("UPDATE user SET defaultOrganizationPinned = 1 WHERE email = ?")
      .run(email);
    const another = await post(
      fixture.auth,
      "/organization/create",
      { name: "Another Organization", slug: "another-organization-12345678" },
      cookie,
    );
    expect(another.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT defaultOrganizationId FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ defaultOrganizationId: organization.id });
  });

  it("keeps a saved default after accepting an invitation and signing in again", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const ownerOrganization = fixture.database
      .query("SELECT defaultOrganizationId AS id FROM user WHERE email = ?")
      .get(email) as { id: string };
    insertBilling(fixture.database, ownerOrganization.id, {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: "price_pro_test",
      stripe_status: "active",
    });

    const invitedEmail = "saved-default@example.com";
    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Saved Default",
      password: originalPassword,
      termsAccepted: true,
    });
    const personalOrganization = fixture.database
      .query("SELECT defaultOrganizationId AS id FROM user WHERE email = ?")
      .get(invitedEmail) as { id: string };
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
    const saved = await app.request(
      "/api/account-settings/default-organization",
      {
        body: JSON.stringify({ organizationId: personalOrganization.id }),
        headers: {
          "content-type": "application/json",
          cookie: inviteeCookie ?? "",
          origin,
        },
        method: "PATCH",
      },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    expect(saved.status).toBe(200);

    const invitation = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: ownerOrganization.id,
        role: "member",
      },
      ownerSignIn.headers.get("set-cookie"),
    );
    expect(invitation.status).toBe(200);
    const invitationId = ((await invitation.json()) as { id: string }).id;
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId },
      inviteeCookie,
    );
    expect(accepted.status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT defaultOrganizationId, defaultOrganizationPinned FROM user WHERE email = ?",
        )
        .get(invitedEmail),
    ).toEqual({
      defaultOrganizationId: personalOrganization.id,
      defaultOrganizationPinned: 1,
    });

    const freshSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    expect(freshSignIn.status).toBe(200);
    expect(
      await (
        await get(
          fixture.auth,
          "/get-session",
          freshSignIn.headers.get("set-cookie"),
        )
      ).json(),
    ).toMatchObject({
      session: { activeOrganizationId: personalOrganization.id },
      user: { defaultOrganizationId: personalOrganization.id },
    });
  });

  it("backfills an organization for an existing user", async () => {
    const database = createTestDatabase({ before: "0004" });
    seedUser(database, {
      createdAt: "2026-08-18T12:00:00.000Z",
      email: "existing@example.com",
      emailVerified: false,
      id: "existing-user",
      name: "Existing User",
    });

    applyMigrations(database, { from: "0004" });

    expect(
      database
        .query(
          `SELECT organization.name, member.role
           FROM user
           JOIN organization
             ON organization.id = user.defaultOrganizationId
           JOIN member ON member.organizationId = organization.id
           WHERE user.id = ?`,
        )
        .get("existing-user"),
    ).toEqual({ name: "Existing User's Organization", role: "owner" });
  });
});

/** Signs up an owner whose default organization pays for Pro. */
async function proOrganizationOwner(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await post(fixture.auth, "/sign-up/email", {
    email,
    name: "Example Person",
    password: originalPassword,
    termsAccepted: true,
  });
  const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
    email,
    password: originalPassword,
  });
  const ownerCookie = ownerSignIn.headers.get("set-cookie");
  const organization = fixture.database
    .query(
      `SELECT organization.id, organization.name
       FROM organization
       JOIN user ON user.defaultOrganizationId = organization.id
       WHERE user.email = ?`,
    )
    .get(email) as { id: string; name: string };

  insertBilling(fixture.database, organization.id, {
    seat_quantity: 1,
    stripe_event_created: 1,
    stripe_price_id: "price_pro_test",
    stripe_status: "active",
  });
  return { organization, ownerCookie };
}

/** An invitee who signed up and accepted an admin invitation. */
async function invitedAdmin(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const { organization, ownerCookie } = await proOrganizationOwner(fixture);
  const invitedEmail = "invitee@example.com";
  const invite = await post(
    fixture.auth,
    "/organization/invite-member",
    {
      email: invitedEmail,
      organizationId: organization.id,
      role: "admin",
    },
    ownerCookie,
  );
  const invitation = (await invite.json()) as { id: string };
  await Promise.all(fixture.pending);
  await post(fixture.auth, "/sign-up/email", {
    email: invitedEmail,
    name: "Invited Person",
    password: originalPassword,
    termsAccepted: true,
  });
  const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
    email: invitedEmail,
    password: originalPassword,
  });
  const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
  await post(
    fixture.auth,
    "/organization/accept-invitation",
    { invitationId: invitation.id },
    inviteeCookie,
  );
  return { invitedEmail, inviteeCookie, organization, ownerCookie };
}
