import { describe, expect, it } from "bun:test";
import { app } from "../app";
import {
  baseURL,
  CookieJar,
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
import { seedUser } from "../testing/seed";
import type { createAuth } from "./auth";
import { withNativeOrigin } from "./nativeRequest";

const replacementPassword = "new correct horse battery staple";

describe("password authentication", () => {
  it.each(["sign-out", "expiry"])(
    "opens the saved default after session %s on web and native",
    async (endSession) => {
      for (const requestOrigin of [
        origin,
        "capacitor://localhost",
        "https://localhost",
      ]) {
        const fixture = await createFixture();
        const { bindings } = fixture;
        const cookies = new CookieJar();
        const request = async (
          path: string,
          body?: Record<string, unknown>,
          method = "POST",
        ) => {
          const response = await app.request(
            `/api${path}`,
            {
              method: body ? method : "GET",
              headers: {
                "content-type": "application/json",
                cookie: cookies.header(),
                ...(requestOrigin === origin
                  ? { origin }
                  : { "X-Balebase-Native-Origin": requestOrigin }),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
            bindings,
            executionContext(fixture.pending),
          );
          expect(response.status).toBe(200);
          cookies.absorb(response);
          return response.json();
        };
        const credentials = {
          email: `${crypto.randomUUID()}@example.com`,
          password: originalPassword,
        };
        await request("/auth/sign-up/email", {
          ...credentials,
          name: "Default Test",
          termsAccepted: true,
        });
        await request("/auth/sign-in/email", credentials);
        const initial = (await request("/auth/get-session")) as {
          session: { id: string; token: string };
          user: { defaultOrganizationId: string };
        };
        const personalId = initial.user.defaultOrganizationId;
        const other = (await request("/auth/organization/create", {
          name: "Other Organization",
          slug: crypto.randomUUID(),
        })) as { id: string };
        await request(
          "/account-settings/default-organization",
          { organizationId: personalId },
          "PATCH",
        );
        await request("/auth/organization/set-active", {
          organizationId: other.id,
        });
        // Refreshing a live session keeps its current workspace. The saved
        // preference applies when a new session is created.
        expect(await request("/auth/get-session")).toMatchObject({
          session: { activeOrganizationId: other.id },
          user: { defaultOrganizationId: personalId },
        });
        if (endSession === "expiry") {
          fixture.database
            .query("UPDATE session SET expiresAt = ? WHERE id = ?")
            .run(
              new Date(Date.now() - 60_000).toISOString(),
              initial.session.id,
            );
        } else {
          await request("/auth/multi-session/revoke", {
            sessionToken: initial.session.token,
          });
        }
        expect(await request("/auth/get-session")).toBeNull();
        await request("/auth/sign-in/email", credentials);
        expect(await request("/auth/get-session")).toMatchObject({
          session: { activeOrganizationId: personalId },
          user: { defaultOrganizationId: personalId },
        });
        await Promise.all(fixture.pending);
      }
    },
  );

  it("supports native cookie sessions without accepting foreign origins", async () => {
    const { auth } = await createFixture();
    // Better Auth skips origin validation in tests unless explicitly enabled.
    (await auth.$context).skipOriginCheck = false;
    await post(auth, "/sign-up/email", {
      email,
      name: "Mobile Person",
      password: originalPassword,
      termsAccepted: true,
    });
    for (const requestOrigin of [
      "capacitor://localhost",
      "https://localhost",
    ]) {
      const nativePost = (
        path: string,
        body: Record<string, unknown>,
        cookie?: string | null,
      ) =>
        auth.handler(
          withNativeOrigin(
            new Request(`${baseURL}/api/auth${path}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Balebase-Native-Origin": requestOrigin,
                Cookie: cookie ?? "",
              },
              body: JSON.stringify(body),
            }),
            origin,
          ),
        );
      const signIn = await nativePost("/sign-in/email", {
        email,
        password: originalPassword,
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get("set-cookie");
      expect(cookie).toContain("session_token=");
      const session = await get(auth, "/get-session", cookie);
      expect(await session.json()).toMatchObject({ user: { email } });
      const rejected = await post(
        auth,
        "/sign-out",
        {},
        cookie,
        "https://attacker.test",
      );
      expect(rejected.status).toBe(403);
      const signedOut = await nativePost("/sign-out", {}, cookie);
      expect(signedOut.status).toBe(200);
      expect(await (await get(auth, "/get-session", cookie)).json()).toBeNull();
    }
  });

  it("requires and records Terms of Service acceptance at sign-up", async () => {
    const fixture = await createFixture();
    const existingUsers = fixture.database
      .query("SELECT COUNT(*) AS count FROM user")
      .get();
    const rejected = await post(fixture.auth, "/sign-up/email", {
      email: "declined@example.com",
      name: "Declined Person",
      password: originalPassword,
      termsAccepted: false,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      message: "You must agree to the Terms of Service to create an account.",
    });
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM user").get(),
    ).toEqual(existingUsers);

    const acceptedAfter = Date.now();
    const accepted = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(accepted.status).toBe(200);
    const record = fixture.database
      .query(
        `SELECT termsAccepted, termsAcceptedAt, termsVersion
         FROM user WHERE email = ?`,
      )
      .get(email) as {
      termsAccepted: number;
      termsAcceptedAt: string;
      termsVersion: string;
    };
    expect(record.termsAccepted).toBe(1);
    expect(record.termsVersion).toBe("2026-08-23");
    expect(new Date(record.termsAcceptedAt).getTime()).toBeGreaterThanOrEqual(
      acceptedAfter,
    );

    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const changed = await post(
      fixture.auth,
      "/update-user",
      { termsAccepted: false },
      signIn.headers.get("set-cookie"),
    );
    expect(changed.status).toBe(400);
    expect(
      fixture.database
        .query("SELECT termsAccepted FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ termsAccepted: 1 });
  });

  it("supports email verification without blocking login", async () => {
    const fixture = await createFixture();

    const signUp = await post(fixture.auth, "/sign-up/email", {
      callbackURL: `${origin}/?verified=true`,
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT role FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ role: "user" });
    const organization = fixture.database
      .query(
        `SELECT organization.id, organization.name, member.role
         FROM organization
         JOIN member ON member.organizationId = organization.id
         JOIN user ON user.defaultOrganizationId = organization.id
         WHERE user.email = ?`,
      )
      .get(email) as { id: string; name: string; role: string };
    expect(organization).toMatchObject({
      name: "Example Person's Organization",
      role: "owner",
    });
    expect(financeGroupFor(fixture.database, organization.id)).toMatchObject({
      capability: "finance",
      memberCount: 1,
      name: "Finance",
    });
    const storedPassword = fixture.database
      .query(
        "SELECT password FROM account WHERE userId = (SELECT id FROM user WHERE email = ?)",
      )
      .get(email) as { password: string };
    expect(storedPassword.password).not.toBe(originalPassword);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(1);
    const verificationMessage = fixture.messages.find(({ subject }) =>
      subject.startsWith("Verify"),
    );
    const verificationURL =
      verificationMessage?.text?.match(/https:\/\/\S+/)?.[0];
    expect(verificationURL).toBeTruthy();

    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie");
    expect(cookie).toContain("better-auth.session_token=");

    const session = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      session: { activeOrganizationId: organization.id },
      user: { email, emailVerified: false, role: "user" },
    });

    const renamed = await post(
      fixture.auth,
      "/organization/update",
      {
        data: { name: "Example Company" },
        organizationId: organization.id,
      },
      cookie,
    );
    expect(renamed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT name FROM organization WHERE id = ?")
        .get(organization.id),
    ).toEqual({ name: "Example Company" });

    const resend = await post(fixture.auth, "/send-verification-email", {
      callbackURL: `${origin}/?verified=true`,
      email,
    });
    expect(resend.status).toBe(200);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(2);

    const verification = await fixture.auth.handler(
      new Request(verificationURL ?? ""),
    );
    expect(verification.status).toBe(302);
    expect(verification.headers.get("location")).toBe(
      `${origin}/?verified=true`,
    );

    const verifiedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(await verifiedSession.json()).toMatchObject({
      user: { emailVerified: true },
    });

    const resetRequest = await post(fixture.auth, "/request-password-reset", {
      email,
      redirectTo: `${origin}/reset-password`,
    });
    expect(resetRequest.status).toBe(200);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(3);

    const resetMessage = fixture.messages.find(({ subject }) =>
      subject.startsWith("Reset"),
    );
    const resetURL = resetMessage?.text?.match(/https:\/\/\S+/)?.[0];
    const token = resetURL?.match(/\/reset-password\/([^?]+)/)?.[1];
    expect(token).toBeTruthy();

    const reset = await post(fixture.auth, "/reset-password", {
      newPassword: replacementPassword,
      token,
    });
    expect(reset.status).toBe(200);

    const revokedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(await revokedSession.json()).toBeNull();

    const oldPassword = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await post(fixture.auth, "/sign-in/email", {
      email,
      password: replacementPassword,
    });
    expect(newPassword.status).toBe(200);
  });

  it("keeps multiple browser accounts signed in and switches between them", async () => {
    const fixture = await createFixture();
    const secondEmail = "second@example.com";
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    await post(fixture.auth, "/sign-up/email", {
      email: secondEmail,
      name: "Second Person",
      password: originalPassword,
      termsAccepted: true,
    });

    const cookies = new CookieJar();
    cookies.absorb(
      await post(
        fixture.auth,
        "/sign-in/email",
        { email, password: originalPassword },
        cookies.header(),
      ),
    );
    cookies.absorb(
      await post(
        fixture.auth,
        "/sign-in/email",
        { email: secondEmail, password: originalPassword },
        cookies.header(),
      ),
    );

    const listing = await get(
      fixture.auth,
      "/multi-session/list-device-sessions",
      cookies.header(),
    );
    expect(listing.status).toBe(200);
    const sessions = (await listing.json()) as DeviceSession[];
    expect(sessions.map(({ user }) => user.email).sort()).toEqual([
      email,
      secondEmail,
    ]);
    expect(await activeEmail(fixture.auth, cookies)).toBe(secondEmail);

    const firstSession = sessions.find(
      (session) => session.user.email === email,
    );
    expect(firstSession).toBeTruthy();
    const switched = await post(
      fixture.auth,
      "/multi-session/set-active",
      { sessionToken: firstSession?.session.token },
      cookies.header(),
    );
    expect(switched.status).toBe(200);
    cookies.absorb(switched);
    expect(await activeEmail(fixture.auth, cookies)).toBe(email);

    const revoked = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: firstSession?.session.token },
      cookies.header(),
    );
    expect(revoked.status).toBe(200);
    cookies.absorb(revoked);
    expect(await activeEmail(fixture.auth, cookies)).toBe(secondEmail);
    const remaining = await get(
      fixture.auth,
      "/multi-session/list-device-sessions",
      cookies.header(),
    );
    expect(await remaining.json()).toMatchObject([
      { user: { email: secondEmail } },
    ]);
  });

  it("enrolls in TOTP only once its first code is verified", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const enrollmentCookies = new CookieJar();
    enrollmentCookies.absorb(
      await post(fixture.auth, "/sign-in/email", {
        email,
        password: originalPassword,
      }),
    );
    expect(
      await (
        await get(fixture.auth, "/get-session", enrollmentCookies.header())
      ).json(),
    ).toMatchObject({ session: { twoFactorVerified: false } });

    const enabled = await post(
      fixture.auth,
      "/two-factor/enable",
      { method: "totp", password: originalPassword },
      enrollmentCookies.header(),
    );
    expect(enabled.status).toBe(200);
    const setup = (await enabled.json()) as {
      backupCodes: string[];
      method: string;
      totpURI: string;
    };
    expect(setup).toMatchObject({ method: "totp" });
    expect(setup.backupCodes).toHaveLength(10);
    expect(setup.totpURI).toStartWith("otpauth://totp/Balebase:");
    const pendingMfa = fixture.database
      .query(
        `SELECT user.twoFactorEnabled, twoFactor.verified,
                twoFactor.secret, twoFactor.backupCodes
         FROM user JOIN twoFactor ON twoFactor.userId = user.id
         WHERE user.email = ?`,
      )
      .get(email) as {
      backupCodes: string;
      secret: string;
      twoFactorEnabled: number;
      verified: number;
    };
    expect(pendingMfa).toMatchObject({
      twoFactorEnabled: 0,
      verified: 0,
    });
    expect(pendingMfa.secret).not.toContain(totpSecret(setup.totpURI));
    expect(pendingMfa.backupCodes).not.toContain(setup.backupCodes[0] ?? "");

    const enrollmentVerification = await post(
      fixture.auth,
      "/two-factor/verify-totp",
      { code: await totpCode(setup.totpURI) },
      enrollmentCookies.header(),
    );
    expect(enrollmentVerification.status).toBe(200);
    enrollmentCookies.absorb(enrollmentVerification);
    expect(
      fixture.database
        .query(
          `SELECT user.twoFactorEnabled, twoFactor.verified
           FROM user JOIN twoFactor ON twoFactor.userId = user.id
           WHERE user.email = ?`,
        )
        .get(email),
    ).toEqual({ twoFactorEnabled: 1, verified: 1 });
    expect(
      await (
        await get(fixture.auth, "/get-session", enrollmentCookies.header())
      ).json(),
    ).toMatchObject({ session: { twoFactorVerified: true } });
  });

  it("requires a TOTP code after the password at sign-in", async () => {
    const fixture = await createFixture();
    const setup = await enrolledInTotp(fixture);

    const loginCookies = new CookieJar();
    const passwordStep = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(passwordStep.status).toBe(200);
    expect(hasMultiSessionCookie(passwordStep)).toBe(false);
    const passwordStepBody: unknown = await passwordStep.json();
    expect(passwordStepBody).toEqual({
      twoFactorMethods: ["totp"],
      twoFactorRedirect: true,
    });
    loginCookies.absorb(passwordStep);
    expect(
      await (
        await get(fixture.auth, "/get-session", loginCookies.header())
      ).json(),
    ).toBeNull();

    const secondFactor = await post(
      fixture.auth,
      "/two-factor/verify-totp",
      { code: await totpCode(setup.totpURI), trustDevice: true },
      loginCookies.header(),
    );
    expect(secondFactor.status).toBe(200);
    expect(hasMultiSessionCookie(secondFactor)).toBe(true);
    const secondFactorBody = (await secondFactor.clone().json()) as {
      token: string;
    };
    loginCookies.absorb(secondFactor);
    expect(
      await (
        await get(fixture.auth, "/get-session", loginCookies.header())
      ).json(),
    ).toMatchObject({
      session: { twoFactorVerified: true },
      user: { email, twoFactorEnabled: true },
    });
    const missingCompanionCookie = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: secondFactorBody.token },
      withoutMultiSessionCookies(loginCookies.header()),
    );
    expect(missingCompanionCookie.status).toBe(401);
    expect(await missingCompanionCookie.json()).toMatchObject({
      code: "INVALID_SESSION_TOKEN",
    });
    const signedOut = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: secondFactorBody.token },
      loginCookies.header(),
    );
    expect(signedOut.status).toBe(200);
  });

  it("accepts each backup code only once", async () => {
    const fixture = await createFixture();
    const setup = await enrolledInTotp(fixture);

    const backupLoginCookies = new CookieJar();
    const backupPasswordStep = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    backupLoginCookies.absorb(backupPasswordStep);
    const backupCode = setup.backupCodes[0] ?? "";
    const recovery = await post(
      fixture.auth,
      "/two-factor/verify-backup-code",
      { code: backupCode },
      backupLoginCookies.header(),
    );
    expect(recovery.status).toBe(200);
    backupLoginCookies.absorb(recovery);
    const reusedRecoveryCode = await post(
      fixture.auth,
      "/two-factor/verify-backup-code",
      { code: backupCode },
      backupLoginCookies.header(),
    );
    expect(reusedRecoveryCode.status).toBe(401);
  });

  it("only lets admins list users", async () => {
    const fixture = await createFixture();
    const signUp = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);

    const userSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const userCookie = userSignIn.headers.get("set-cookie");
    const forbidden = await get(
      fixture.auth,
      "/admin/list-users?limit=25",
      userCookie,
    );
    expect(forbidden.status).toBe(403);

    const nullableRoleEmail = "null-role@example.com";
    expect(
      (
        await post(fixture.auth, "/sign-up/email", {
          email: nullableRoleEmail,
          name: "Nullable Role",
          password: originalPassword,
          termsAccepted: true,
        })
      ).status,
    ).toBe(200);
    fixture.database
      .query('UPDATE "user" SET role = ? WHERE email = ?')
      .run("admin", email);
    fixture.database
      .query('UPDATE "user" SET role = NULL, lastActiveAt = ? WHERE email = ?')
      .run("2026-10-15T08:30:00.000Z", nullableRoleEmail);
    expect(
      fixture.database
        .query("SELECT role FROM user WHERE id = 'system:audit-library'")
        .get(),
    ).toEqual({ role: "system" });
    const adminSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const adminCookie = adminSignIn.headers.get("set-cookie");
    const firstPage = await get(
      fixture.auth,
      "/admin/list-users?filterField=id&filterOperator=ne&filterValue=system%3Aaudit-library&limit=1&offset=0&sortBy=email&sortDirection=asc",
      adminCookie,
    );
    const secondPage = await get(
      fixture.auth,
      "/admin/list-users?filterField=id&filterOperator=ne&filterValue=system%3Aaudit-library&limit=1&offset=1&sortBy=email&sortDirection=asc",
      adminCookie,
    );
    expect(firstPage.status).toBe(200);
    expect(secondPage.status).toBe(200);
    expect(await firstPage.json()).toMatchObject({
      limit: 1,
      total: 2,
      users: [
        {
          email: nullableRoleEmail,
          lastActiveAt: "2026-10-15T08:30:00.000Z",
          role: null,
        },
      ],
    });
    expect(await secondPage.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 2,
      users: [{ email, lastActiveAt: null, role: "admin" }],
    });
  });

  it("keeps platform role changes off Better Auth's admin endpoints", async () => {
    const fixture = await createFixture();
    for (const address of [email, "other@example.com"]) {
      expect(
        (
          await post(fixture.auth, "/sign-up/email", {
            email: address,
            name: "Example Person",
            password: originalPassword,
            termsAccepted: true,
          })
        ).status,
      ).toBe(200);
    }
    fixture.database
      .query('UPDATE "user" SET role = ? WHERE email IN (?, ?)')
      .run("admin", email, "other@example.com");
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const cookie = signIn.headers.get("set-cookie") ?? "";
    const roles = () =>
      fixture.database
        .query(
          'SELECT email, role FROM "user" WHERE email LIKE ? ORDER BY email',
        )
        .all("%@example.com");
    const before = roles();
    const other = fixture.database
      .query('SELECT id FROM "user" WHERE email = ?')
      .get("other@example.com") as { id: string };
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["/admin/set-role", { userId: other.id, role: "user" }],
      ["/admin/update-user", { userId: other.id, data: { role: "user" } }],
      [
        "/admin/create-user",
        {
          email: "new@example.com",
          name: "New",
          password: originalPassword,
          role: "admin",
        },
      ],
    ];
    for (const [path, body] of attempts) {
      const response = await post(fixture.auth, path, body, cookie);
      expect(response.status).toBe(404);
    }
    expect(roles()).toEqual(before);
    // Listing stays available to admins.
    expect(
      (await get(fixture.auth, "/admin/list-users?limit=1", cookie)).status,
    ).toBe(200);
  });

  it("records when a signed-in user was last active", async () => {
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
    const cookie = signIn.headers.get("set-cookie") ?? "";
    const lastActiveAt = () =>
      (
        fixture.database
          .query("SELECT lastActiveAt FROM user WHERE email = ?")
          .get(email) as { lastActiveAt: string | null }
      ).lastActiveAt;
    const requestMe = async () => {
      const response = await app.request(
        "/api/me",
        { headers: { cookie } },
        fixture.bindings,
        executionContext(fixture.pending),
      );
      await Promise.all(fixture.pending);
      return response;
    };
    expect(lastActiveAt()).toBeNull();

    const activeAfter = Date.now();
    expect((await requestMe()).status).toBe(200);
    expect(new Date(lastActiveAt() ?? "").getTime()).toBeGreaterThanOrEqual(
      activeAfter,
    );

    const later = "2999-01-01T00:00:00.000Z";
    fixture.database
      .query("UPDATE user SET lastActiveAt = ? WHERE email = ?")
      .run(later, email);
    expect((await requestMe()).status).toBe(200);
    expect(lastActiveAt()).toBe(later);
  });

  it("backfills last activity from account creation", async () => {
    const database = createTestDatabase({ before: "0055" });
    seedUser(database, {
      createdAt: "2026-08-18T12:00:00.000Z",
      email: "existing@example.com",
      emailVerified: false,
      id: "existing-user",
      name: "Existing User",
    });
    database
      .query("UPDATE user SET updatedAt = ? WHERE id = ?")
      .run("2026-09-01T12:00:00.000Z", "existing-user");

    applyMigrations(database, { from: "0055" });

    expect(
      database
        .query("SELECT lastActiveAt FROM user WHERE id = ?")
        .get("existing-user"),
    ).toEqual({ lastActiveAt: "2026-08-18T12:00:00.000Z" });
  });

  it("does not mark an impersonated user as active", async () => {
    const fixture = await createFixture();
    const impersonatedEmail = "impersonated@example.com";
    for (const [userEmail, name] of [
      [email, "Example Admin"],
      [impersonatedEmail, "Impersonated Person"],
    ]) {
      await post(fixture.auth, "/sign-up/email", {
        email: userEmail,
        name,
        password: originalPassword,
        termsAccepted: true,
      });
    }
    fixture.database
      .query('UPDATE "user" SET role = ? WHERE email = ?')
      .run("admin", email);
    const adminSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const impersonated = fixture.database
      .query("SELECT id FROM user WHERE email = ?")
      .get(impersonatedEmail) as { id: string };
    const impersonation = await post(
      fixture.auth,
      "/admin/impersonate-user",
      { userId: impersonated.id },
      adminSignIn.headers.get("set-cookie"),
    );
    expect(impersonation.status).toBe(200);
    const cookies = new CookieJar();
    cookies.absorb(impersonation);

    const response = await app.request(
      "/api/me",
      { headers: { cookie: cookies.header() } },
      fixture.bindings,
      executionContext(fixture.pending),
    );
    await Promise.all(fixture.pending);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { email: impersonatedEmail },
    });
    expect(
      fixture.database
        .query("SELECT lastActiveAt FROM user WHERE email = ?")
        .get(impersonatedEmail),
    ).toEqual({ lastActiveAt: null });
  });
});

interface DeviceSession {
  session: { token: string };
  user: { email: string };
}

function totpSecret(uri: string) {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI is missing its secret.");
  return secret;
}

function hasMultiSessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .some((header) => header.includes("_multi-"));
}

function withoutMultiSessionCookies(header: string) {
  return header
    .split("; ")
    .filter((cookie) => !cookie.includes("_multi-"))
    .join("; ");
}

async function totpCode(uri: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(totpSecret(uri)),
    { hash: "SHA-1", name: "HMAC" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(
    0,
    BigInt(Math.floor(Date.now() / 30_000)),
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const value =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return (value % 1_000_000).toString().padStart(6, "0");
}

function decodeBase32(encoded: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replace(/=+$/, "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("TOTP secret is not valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Uint8Array.from(bytes);
}

async function activeEmail(
  auth: ReturnType<typeof createAuth>,
  cookies: CookieJar,
) {
  const response = await get(auth, "/get-session", cookies.header());
  const session = (await response.json()) as { user: { email: string } };
  return session.user.email;
}

/** Signs the person up and enrolls them in TOTP, returning its setup. */
async function enrolledInTotp(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await post(fixture.auth, "/sign-up/email", {
    email,
    name: "Example Person",
    password: originalPassword,
    termsAccepted: true,
  });
  const enrollmentCookies = new CookieJar();
  enrollmentCookies.absorb(
    await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    }),
  );
  const enabled = await post(
    fixture.auth,
    "/two-factor/enable",
    { method: "totp", password: originalPassword },
    enrollmentCookies.header(),
  );
  const setup = (await enabled.json()) as {
    backupCodes: string[];
    method: string;
    totpURI: string;
  };
  await post(
    fixture.auth,
    "/two-factor/verify-totp",
    { code: await totpCode(setup.totpURI) },
    enrollmentCookies.header(),
  );
  return setup;
}
