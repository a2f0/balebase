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

async function history(fixture: Fixture, cookies: CookieJar) {
  const response = await app.request(
    "/api/account-settings/security-events",
    { headers: { cookie: cookies.header(), origin } },
    fixture.bindings,
    executionContext(fixture.pending),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    events: { action: string; occurredAt: string }[];
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
  fixture.database.exec(
    "CREATE TRIGGER reject_security_event BEFORE INSERT ON user_security_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  const changed = await post(
    fixture.auth,
    "/change-password",
    { currentPassword: originalPassword, newPassword: changedPassword },
    cookies.header(),
  );
  expect(changed.status).not.toBe(200);
  fixture.database.exec("DROP TRIGGER reject_security_event");
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
