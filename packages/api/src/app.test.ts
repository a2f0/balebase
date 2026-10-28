import { describe, expect, it } from "bun:test";
import { version } from "../package.json";
import { app } from "./app";
import { createAuth } from "./auth";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { seedMember, seedUser } from "./testing/seed";

describe("api", () => {
  it("applies native origins through the real authenticated route middleware", async () => {
    const fixture = await protectedOrganizationFixture();
    for (const marker of ["capacitor://localhost", "https://localhost"]) {
      for (const browserOrigin of [undefined, "https://attacker.test"]) {
        const headers = new Headers({
          Cookie: fixture.cookie,
          "Content-Type": "application/json",
          "X-Balebase-Native-Origin": marker,
        });
        if (browserOrigin) headers.set("Origin", browserOrigin);
        const response = await app.request(
          "/api/account-settings/deletion",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ confirm: "delete my account" }),
          },
          fixture.bindings,
          fixture.executionContext,
        );
        expect(response.status).toBe(browserOrigin ? 403 : 200);
      }
    }
  });
  it("allows only the web client through CORS, excluding native-only headers", async () => {
    for (const origin of [
      "https://app.test",
      "capacitor://localhost",
      "https://localhost",
      "https://localhost.attacker.test",
      "capacitor://attacker.test",
      "https://attacker.test",
    ]) {
      const response = await app.request(
        "/api/auth/sign-in/email",
        {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
              "content-type,x-balebase-native-origin",
          },
        },
        authBindings(),
      );
      expect(response.headers.get("access-control-allow-origin")).toBe(
        origin === "https://app.test" ? origin : null,
      );
      expect(
        response.headers.get("access-control-allow-headers")?.toLowerCase(),
      ).not.toContain("x-balebase-native-origin");
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    }
  });

  it("requires authentication for maintenance and account deletion routes", async () => {
    for (const [path, method] of [
      ["/api/admin/jobs", "GET"],
      ["/api/admin/users", "GET"],
      ["/api/admin/users/user-id/deletion", "POST"],
      ["/api/admin/users/user-id/deletion", "DELETE"],
      ["/api/admin/audit-templates", "GET"],
      ["/api/admin/audit-templates", "POST"],
      ["/api/admin/audit-templates/template-id", "PUT"],
      ["/api/activity", "GET"],
      ["/api/issues", "GET"],
      ["/api/issues", "POST"],
      ["/api/issues/members", "GET"],
      ["/api/issues/private", "PATCH"],
      ["/api/issues/private/activity", "GET"],
      ["/api/audits/runs/private/activity", "GET"],
      ["/api/admin/jobs/purgeRequestedUsers/run", "POST"],
      ["/api/account-settings/deletion", "GET"],
      ["/api/account-settings/deletion", "POST"],
      ["/api/account-settings/deletion", "DELETE"],
    ] as const) {
      const response = await app.request(path, { method }, authBindings());
      expect(response.status).toBe(401);
    }
  });

  it("reports its health", async () => {
    const response = await app.request("/health", undefined, testBindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("returns a JSON 404", async () => {
    const response = await app.request("/missing", undefined, testBindings());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found."}');
  });

  it("exposes response headers needed by the cross-origin client", async () => {
    const response = await app.request(
      "/api",
      { headers: { Origin: "https://app.test" } },
      authBindings(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.test",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "Retry-After,X-Document-Revision,API-Version",
    );
  });

  it("names the API version on every response", async () => {
    const responses = [
      await app.request("/health", undefined, testBindings()),
      await app.request("/missing", undefined, testBindings()),
      await app.request("/api/me", undefined, authBindings()),
      await app.request(
        "/api/inbox",
        {
          headers: {
            "Access-Control-Request-Method": "GET",
            Origin: "https://app.test",
          },
          method: "OPTIONS",
        },
        authBindings(),
      ),
      await app.request("/api/auth/ok", undefined, authBindings(), {
        passThroughOnException: () => undefined,
        props: {},
        waitUntil: () => undefined,
      } as unknown as ExecutionContext),
      await app.request(
        "/api/auth/get-session",
        undefined,
        testBindings({
          DB: toD1(createTestDatabase(), {
            onQuery: () => {
              throw new Error("D1 is unavailable.");
            },
          }),
        }),
      ),
    ];

    // Health, not found, unauthenticated, a CORS preflight, a Better Auth
    // response, and an unexpected error.
    expect(responses.map((response) => response.status)).toEqual([
      200, 404, 401, 204, 200, 500,
    ]);
    for (const response of responses) {
      expect(response.headers.get("API-Version")).toBe(version);
    }
  });

  it("requires authentication for the inbox", async () => {
    const response = await app.request("/api/inbox", undefined, authBindings());

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Authentication required.",
    });
  });

  it("requires authentication to change the default organization", async () => {
    const response = await app.request(
      "/api/account-settings/default-organization",
      {
        body: JSON.stringify({ organizationId: "organization-id" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to delete an inbox message", async () => {
    const response = await app.request(
      "/api/inbox/email-id",
      { method: "DELETE" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to restore an inbox message", async () => {
    const response = await app.request(
      "/api/inbox/email-id/restore",
      { method: "POST" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for the admin organization list", async () => {
    const response = await app.request(
      "/api/admin/organizations",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization details", async () => {
    const response = await app.request(
      "/api/admin/organizations/organization-id",
      undefined,
      authBindings(),
    );
    expect(response.status).toBe(401);
  });

  it("requires platform admin access on every admin route, even for an organization owner", async () => {
    const fixture = await protectedOrganizationFixture();
    const adminRoutes = app.routes.filter(
      ({ method, path }) =>
        method !== "ALL" && /^\/api\/admin(?:\/|$)/.test(path),
    );
    expect(adminRoutes.map(({ path }) => path.split("/")[3])).toEqual(
      expect.arrayContaining([
        undefined,
        "audit-templates",
        "jobs",
        "organizations",
        "users",
      ]),
    );
    for (const { method, path } of adminRoutes) {
      const url = path.replaceAll(/:\w+/g, fixture.organizationId);
      const signedOut = await app.request(url, { method }, authBindings());
      expect([method, path, signedOut.status]).toEqual([method, path, 401]);
      const response = await app.request(
        url,
        { headers: { cookie: fixture.cookie }, method },
        fixture.bindings,
        fixture.executionContext,
      );
      expect([method, path, response.status]).toEqual([method, path, 403]);
      const body: unknown = await response.json();
      expect(body).toEqual({
        error: "Insufficient permissions.",
      });
    }
  });

  it("requires authentication to mark an organization for deletion", async () => {
    const response = await app.request(
      "/api/admin/organizations/organization-id",
      { method: "DELETE" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to restore an organization", async () => {
    const response = await app.request(
      "/api/admin/organizations/organization-id/restore",
      { method: "POST" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for audits", async () => {
    const response = await app.request(
      "/api/audits/templates",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for finance", async () => {
    const response = await app.request(
      "/api/finance",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for businesses", async () => {
    const response = await app.request(
      "/api/businesses",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization settings", async () => {
    const response = await app.request(
      "/api/organization-settings/people",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization member data", async () => {
    const response = await app.request(
      "/api/auth/organization/list-members",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization plugin mutations", async () => {
    const response = await app.request(
      "/api/auth/organization/update",
      {
        body: JSON.stringify({
          data: { name: "Bypassed Requirement" },
          organizationId: "organization-id",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      authBindings(),
    );

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "Authentication required." });
  });

  it("blocks protected mutations from an unverified authenticated session", async () => {
    const fixture = await protectedOrganizationFixture();
    const headers = {
      "content-type": "application/json",
      cookie: fixture.cookie,
      origin: "https://app.test",
    };

    const customMutation = await app.request(
      `/api/organization-settings/people/${fixture.memberId}/two-factor-required`,
      {
        body: JSON.stringify({ required: false }),
        headers,
        method: "PATCH",
      },
      fixture.bindings,
      fixture.executionContext,
    );
    expect(customMutation.status).toBe(403);
    expect(await customMutation.json()).toMatchObject({
      code: "TWO_FACTOR_SETUP_REQUIRED",
    });
    expect(
      fixture.database
        .query("SELECT twoFactorRequired FROM member WHERE id = ?")
        .get(fixture.memberId),
    ).toEqual({ twoFactorRequired: 1 });

    const pluginMutation = await app.request(
      "/api/auth/organization/leave",
      {
        body: JSON.stringify({ organizationId: fixture.organizationId }),
        headers,
        method: "POST",
      },
      fixture.bindings,
      fixture.executionContext,
    );
    expect(pluginMutation.status).toBe(403);
    expect(await pluginMutation.json()).toMatchObject({
      code: "TWO_FACTOR_SETUP_REQUIRED",
    });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM member WHERE id = ? AND organizationId = ?",
        )
        .get(fixture.memberId, fixture.organizationId),
    ).toEqual({ count: 1 });
  });

  it("names the missing seat on organization plugin routes but lets the member leave", async () => {
    const fixture = await protectedOrganizationFixture();
    // An earlier owner holds the Free plan's one seat.
    seedUser(fixture.database, { id: "seat-holder", name: "Seat Holder" });
    seedMember(fixture.database, {
      createdAt: "2026-01-01",
      id: "seat-member",
      organizationId: fixture.organizationId,
      role: "owner",
      userId: "seat-holder",
    });
    fixture.database
      .query(
        "UPDATE member SET createdAt = '2026-02-01', twoFactorRequired = 0 WHERE id = ?",
      )
      .run(fixture.memberId);
    const request = (path: string, body?: Record<string, unknown>) =>
      app.request(
        path,
        {
          headers: {
            "content-type": "application/json",
            cookie: fixture.cookie,
            origin: "https://app.test",
          },
          ...(body ? { body: JSON.stringify(body), method: "POST" } : {}),
        },
        fixture.bindings,
        fixture.executionContext,
      );
    const members = `/api/auth/organization/list-members?organizationId=${fixture.organizationId}`;

    const owner = await request(members);
    expect(owner.status).toBe(403);
    expect(await owner.json()).toMatchObject({ code: "UPGRADE_REQUIRED" });
    fixture.database
      .query("UPDATE member SET role = 'member' WHERE id = ?")
      .run(fixture.memberId);
    const member = await request(members);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ code: "SEAT_UNAVAILABLE" });

    const leave = await request("/api/auth/organization/leave", {
      organizationId: fixture.organizationId,
    });
    expect(leave.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM member WHERE id = ?")
        .get(fixture.memberId),
    ).toEqual({ count: 0 });
  });
});

function authBindings(database = createTestDatabase()) {
  return testBindings({ DB: toD1(database) });
}

async function protectedOrganizationFixture() {
  const database = createTestDatabase();
  const bindings = authBindings(database);
  const pending: Promise<unknown>[] = [];
  const auth = createAuth(bindings, (promise) => pending.push(promise));
  const authRequest = (path: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`https://api.test/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
        },
        method: "POST",
      }),
    );
  const email = "protected@example.com";
  const password = "correct horse battery staple";
  const signUp = await authRequest("/sign-up/email", {
    email,
    name: "Protected Person",
    password,
    termsAccepted: true,
  });
  expect(signUp.status).toBe(200);
  await Promise.all(pending);
  const signIn = await authRequest("/sign-in/email", { email, password });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  const membership = database
    .query(
      `SELECT member.id AS memberId, member.organizationId
       FROM member JOIN user ON user.id = member.userId
       WHERE user.email = ?`,
    )
    .get(email) as { memberId: string; organizationId: string };
  database
    .query("UPDATE member SET twoFactorRequired = 1 WHERE id = ?")
    .run(membership.memberId);
  return {
    bindings,
    cookie: cookie ?? "",
    database,
    executionContext: {
      passThroughOnException: () => undefined,
      props: {},
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext,
    ...membership,
  };
}
