import { expect, it } from "bun:test";
import { app } from "../app";
import {
  CookieJar,
  createFixture,
  email,
  executionContext,
  origin,
  originalPassword,
  post,
  totpCode,
} from "../testing/authFixture";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const changedPassword = "a different horse battery staple";
const resetPassword = "yet another horse battery staple";

async function signedIn(fixture: Fixture, address: string, password: string) {
  const cookies = new CookieJar();
  const response = await post(fixture.auth, "/sign-in/email", {
    email: address,
    password,
  });
  expect(response.status).toBe(200);
  cookies.absorb(response);
  return cookies;
}

async function signUp(fixture: Fixture, address: string) {
  const response = await post(fixture.auth, "/sign-up/email", {
    email: address,
    name: "Example Person",
    password: originalPassword,
    termsAccepted: true,
  });
  expect(response.status).toBe(200);
  return signedIn(fixture, address, originalPassword);
}

const recorded = (fixture: Fixture) =>
  fixture.database
    .query(
      `SELECT user.email, user_security_events.action FROM user_security_events
       JOIN user ON user.id = user_security_events.user_id
       ORDER BY user_security_events.id`,
    )
    .all();

const rejectHistory = (fixture: Fixture) =>
  fixture.database.exec(
    "CREATE TRIGGER reject_security_event BEFORE INSERT ON user_security_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
const allowHistory = (fixture: Fixture) =>
  fixture.database.exec("DROP TRIGGER reject_security_event");
const twoFactorState = (fixture: Fixture) =>
  fixture.database
    .query(
      `SELECT user.twoFactorEnabled, twoFactor.verified FROM user
       LEFT JOIN twoFactor ON twoFactor.userId = user.id WHERE user.email = ?`,
    )
    .get(email);

async function history(fixture: Fixture, cookies: CookieJar) {
  const response = await app.request(
    "/api/account-settings/security-events",
    { headers: { cookie: cookies.header(), origin } },
    fixture.bindings,
    executionContext(fixture.pending),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    events: {
      action: string;
      change: { after: string; before: string } | null;
      occurredAt: string;
    }[];
  };
}

it("records two-factor and password changes only when they happen", async () => {
  const fixture = await createFixture();
  let cookies = await signUp(fixture, email);
  const enabled = await post(
    fixture.auth,
    "/two-factor/enable",
    { password: originalPassword },
    cookies.header(),
  );
  const { totpURI } = (await enabled.json()) as { totpURI: string };
  // Starting enrollment and a wrong code change nothing.
  expect(
    (
      await post(
        fixture.auth,
        "/two-factor/verify-totp",
        { code: "000000" },
        cookies.header(),
      )
    ).status,
  ).not.toBe(200);
  expect(recorded(fixture)).toEqual([]);
  const verified = await post(
    fixture.auth,
    "/two-factor/verify-totp",
    { code: await totpCode(totpURI) },
    cookies.header(),
  );
  expect(verified.status).toBe(200);
  cookies.absorb(verified);
  expect(recorded(fixture)).toEqual([{ email, action: "two_factor_enabled" }]);

  for (const [path, body] of [
    ["/two-factor/disable", { password: "not the password at all" }],
    [
      "/change-password",
      {
        currentPassword: "not the password at all",
        newPassword: changedPassword,
      },
    ],
  ] as const) {
    expect(
      (await post(fixture.auth, path, body, cookies.header())).status,
    ).not.toBe(200);
  }
  expect(recorded(fixture)).toHaveLength(1);

  const disabled = await post(
    fixture.auth,
    "/two-factor/disable",
    { password: originalPassword },
    cookies.header(),
  );
  expect(disabled.status).toBe(200);
  cookies.absorb(disabled);
  const changed = await post(
    fixture.auth,
    "/change-password",
    { currentPassword: originalPassword, newPassword: changedPassword },
    cookies.header(),
  );
  expect(changed.status).toBe(200);

  expect(
    (
      await post(fixture.auth, "/request-password-reset", {
        email,
        redirectTo: `${origin}/reset-password`,
      })
    ).status,
  ).toBe(200);
  await Promise.all(fixture.pending);
  const token = fixture.messages
    .find(({ subject }) => subject.startsWith("Reset"))
    ?.text?.match(/\/reset-password\/([^?\s]+)/)?.[1];
  expect(
    (
      await post(fixture.auth, "/reset-password", {
        newPassword: resetPassword,
        token,
      })
    ).status,
  ).toBe(200);
  expect(recorded(fixture)).toEqual([
    { email, action: "two_factor_enabled" },
    { email, action: "two_factor_disabled" },
    { email, action: "password_changed" },
    { email, action: "password_changed" },
  ]);

  // Only the person reads their own history, newest first.
  cookies = await signedIn(fixture, email, resetPassword);
  expect((await history(fixture, cookies)).events.map((e) => e.action)).toEqual(
    [
      "password_changed",
      "password_changed",
      "two_factor_disabled",
      "two_factor_enabled",
    ],
  );
  const other = await signUp(fixture, "other@example.com");
  expect(await history(fixture, other)).toEqual({ events: [] });
  const anonymous = await app.request(
    "/api/account-settings/security-events",
    undefined,
    fixture.bindings,
    executionContext(fixture.pending),
  );
  expect(anonymous.status).toBe(401);
});

it("keeps the old password when the change cannot be recorded", async () => {
  const fixture = await createFixture();
  const cookies = await signUp(fixture, email);
  rejectHistory(fixture);
  const changed = await post(
    fixture.auth,
    "/change-password",
    { currentPassword: originalPassword, newPassword: changedPassword },
    cookies.header(),
  );
  expect(changed.status).not.toBe(200);
  allowHistory(fixture);
  expect(recorded(fixture)).toEqual([]);
  await signedIn(fixture, email, originalPassword);
  expect(
    (
      await post(fixture.auth, "/sign-in/email", {
        email,
        password: changedPassword,
      })
    ).status,
  ).toBe(401);
});

it("keeps two-factor enrollment and removal consistent when they cannot be recorded", async () => {
  const fixture = await createFixture();
  const cookies = await signUp(fixture, email);
  const enabled = await post(
    fixture.auth,
    "/two-factor/enable",
    { password: originalPassword },
    cookies.header(),
  );
  const { totpURI } = (await enabled.json()) as { totpURI: string };
  rejectHistory(fixture);
  const verify = () =>
    totpCode(totpURI).then((code) =>
      post(fixture.auth, "/two-factor/verify-totp", { code }, cookies.header()),
    );
  expect((await verify()).status).not.toBe(200);
  expect(twoFactorState(fixture)).toEqual({
    twoFactorEnabled: 0,
    verified: 0,
  });
  allowHistory(fixture);
  const verified = await verify();
  expect(verified.status).toBe(200);
  cookies.absorb(verified);
  expect(twoFactorState(fixture)).toEqual({
    twoFactorEnabled: 1,
    verified: 1,
  });
  expect(recorded(fixture)).toEqual([{ email, action: "two_factor_enabled" }]);

  rejectHistory(fixture);
  const disable = () =>
    post(
      fixture.auth,
      "/two-factor/disable",
      { password: originalPassword },
      cookies.header(),
    );
  expect((await disable()).status).not.toBe(200);
  // Better Auth turns the setting off before deleting the authenticator, so
  // the refused change leaves both in place.
  expect(twoFactorState(fixture)).toEqual({
    twoFactorEnabled: 1,
    verified: 1,
  });
  allowHistory(fixture);
  expect((await disable()).status).toBe(200);
  expect(twoFactorState(fixture)).toEqual({
    twoFactorEnabled: 0,
    verified: null,
  });
  expect(recorded(fixture)).toEqual([
    { email, action: "two_factor_enabled" },
    { email, action: "two_factor_disabled" },
  ]);
});

const twoFactorRow = (fixture: Fixture) =>
  fixture.database
    .query(
      `SELECT secret, backupCodes, verified, activity_change FROM twoFactor
       JOIN user ON user.id = twoFactor.userId WHERE user.email = ?`,
    )
    .get(email) as {
    activity_change: string | null;
    backupCodes: string;
    secret: string;
    verified: number;
  };

async function enrolled(fixture: Fixture) {
  const cookies = await signUp(fixture, email);
  const enable = () =>
    post(
      fixture.auth,
      "/two-factor/enable",
      { password: originalPassword },
      cookies.header(),
    );
  // Starting again before verifying is still the first enrollment.
  expect((await enable()).status).toBe(200);
  const { totpURI } = (await (await enable()).json()) as { totpURI: string };
  expect(recorded(fixture)).toEqual([]);
  const verified = await post(
    fixture.auth,
    "/two-factor/verify-totp",
    { code: await totpCode(totpURI) },
    cookies.header(),
  );
  expect(verified.status).toBe(200);
  cookies.absorb(verified);
  return { cookies, enable };
}

it("records replacing the authenticator and regenerating backup codes, not using one", async () => {
  const fixture = await createFixture();
  const { cookies, enable } = await enrolled(fixture);
  const regenerate = (password: string) =>
    post(
      fixture.auth,
      "/two-factor/generate-backup-codes",
      { password },
      cookies.header(),
    );
  const wrong = "not the password at all";
  expect(
    (
      await post(
        fixture.auth,
        "/two-factor/enable",
        { password: wrong },
        cookies.header(),
      )
    ).status,
  ).not.toBe(200);
  expect((await regenerate(wrong)).status).not.toBe(200);
  expect(recorded(fixture)).toEqual([{ email, action: "two_factor_enabled" }]);

  // Better Auth limits two-factor requests per address; these are few.
  const allowRequests = () =>
    fixture.database.exec("DELETE FROM rateLimit WHERE key IS NOT NULL");
  allowRequests();
  const original = twoFactorRow(fixture);
  expect((await enable()).status).toBe(200);
  const replaced = twoFactorRow(fixture);
  expect(replaced.secret).not.toBe(original.secret);
  expect(replaced.verified).toBe(1);
  const regenerated = await regenerate(originalPassword);
  expect(regenerated.status).toBe(200);
  const { backupCodes } = (await regenerated.json()) as {
    backupCodes: string[];
  };
  expect(twoFactorRow(fixture)).toMatchObject({
    activity_change: null,
    secret: replaced.secret,
  });
  expect(twoFactorRow(fixture).backupCodes).not.toBe(replaced.backupCodes);

  // Using a backup code rewrites the codes but regenerates nothing.
  const beforeUse = twoFactorRow(fixture).backupCodes;
  allowRequests();
  const used = await post(
    fixture.auth,
    "/two-factor/verify-backup-code",
    { code: backupCodes[0] },
    cookies.header(),
  );
  expect(used.status).toBe(200);
  expect(twoFactorRow(fixture).backupCodes).not.toBe(beforeUse);

  expect(recorded(fixture)).toEqual([
    { email, action: "two_factor_enabled" },
    { email, action: "two_factor_authenticator_replaced" },
    { email, action: "two_factor_backup_codes_regenerated" },
  ]);
  cookies.absorb(used);
  expect((await history(fixture, cookies)).events).toMatchObject([
    { action: "two_factor_backup_codes_regenerated", change: null },
    { action: "two_factor_authenticator_replaced", change: null },
    { action: "two_factor_enabled", change: null },
  ]);
});

it("keeps the old authenticator and backup codes when the change cannot be recorded", async () => {
  const fixture = await createFixture();
  const { cookies, enable } = await enrolled(fixture);
  const original = twoFactorRow(fixture);
  rejectHistory(fixture);
  expect((await enable()).status).not.toBe(200);
  expect(
    (
      await post(
        fixture.auth,
        "/two-factor/generate-backup-codes",
        { password: originalPassword },
        cookies.header(),
      )
    ).status,
  ).not.toBe(200);
  allowHistory(fixture);
  expect(twoFactorRow(fixture)).toEqual(original);
  expect(recorded(fixture)).toEqual([{ email, action: "two_factor_enabled" }]);
});

it("records profile name and picture changes once, with the old and new name", async () => {
  const fixture = await createFixture();
  const cookies = await signUp(fixture, email);
  const update = (data: Record<string, unknown>) =>
    post(fixture.auth, "/update-user", data, cookies.header());
  expect((await update({ name: "Example Person" })).status).toBe(200);
  expect(recorded(fixture)).toEqual([]);
  expect((await update({ name: "Renamed Person" })).status).toBe(200);
  expect((await update({ image: "https://example.com/me.png" })).status).toBe(
    200,
  );
  expect((await update({ image: "https://example.com/me.png" })).status).toBe(
    200,
  );
  expect(recorded(fixture)).toEqual([
    { email, action: "name_changed" },
    { email, action: "image_changed" },
  ]);
  expect((await history(fixture, cookies)).events).toMatchObject([
    { action: "image_changed", change: null },
    {
      action: "name_changed",
      change: { before: "Example Person", after: "Renamed Person" },
    },
  ]);
  // The picture's address is not kept.
  expect(
    fixture.database
      .query(
        "SELECT details FROM user_security_events WHERE action = 'image_changed'",
      )
      .get(),
  ).toEqual({ details: null });

  rejectHistory(fixture);
  expect((await update({ name: "Third Name" })).status).not.toBe(200);
  allowHistory(fixture);
  expect(
    fixture.database.query("SELECT name FROM user WHERE email = ?").get(email),
  ).toEqual({ name: "Renamed Person" });
});
