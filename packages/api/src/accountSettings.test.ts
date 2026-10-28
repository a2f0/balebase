import { describe, expect, it } from "bun:test";
import { accountSettings } from "./accountSettings";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { seedAccount, seedMember, seedOrganization } from "./testing/seed";
import { testApp } from "./testing/session";

describe("default organization settings", () => {
  it("saves an explicit choice from the user's active memberships", async () => {
    const fixture = createFixture();
    const response = await fixture.request("member", "shared");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ defaultOrganizationId: "shared" });
    expect(fixture.defaultFor("member")).toEqual({
      defaultOrganizationId: "shared",
      defaultOrganizationPinned: 1,
    });
    expect(fixture.defaultFor("other")).toEqual({
      defaultOrganizationId: "org_other",
      defaultOrganizationPinned: 0,
    });
  });

  it("rejects organizations the user does not belong to", async () => {
    const fixture = createFixture();
    const response = await fixture.request("other", "shared");

    expect(response.status).toBe(403);
    expect(fixture.defaultFor("other")).toEqual({
      defaultOrganizationId: "org_other",
      defaultOrganizationPinned: 0,
    });
  });

  it("rejects deleted organizations and invalid input", async () => {
    const fixture = createFixture();
    fixture.database
      .query("UPDATE organization SET deletedAt = ? WHERE id = ?")
      .run("2026-09-23T00:00:00Z", "shared");

    expect((await fixture.request("member", "shared")).status).toBe(403);
    expect((await fixture.request("member", 123)).status).toBe(400);
    expect(fixture.defaultFor("member")).toEqual({
      defaultOrganizationId: "org_member",
      defaultOrganizationPinned: 0,
    });
  });
});

function createFixture() {
  const database = createTestDatabase();
  for (const id of ["member", "other"]) {
    seedAccount(database, {
      createdAt: "2026-09-23T00:00:00Z",
      id,
      organizationName: id,
    });
  }
  seedOrganization(database, {
    createdAt: "2026-09-23T00:00:00Z",
    id: "shared",
    name: "Shared",
  });
  seedMember(database, {
    createdAt: "2026-09-23T00:00:00Z",
    id: "shared-member",
    organizationId: "shared",
    userId: "member",
  });

  const app = testApp({ "/": accountSettings }, (context) => ({
    userId: context.req.header("x-test-user"),
  }));
  const request = requester(app, testBindings({ DB: toD1(database) }));
  return {
    database,
    defaultFor: (userId: string) =>
      database
        .query(
          "SELECT defaultOrganizationId, defaultOrganizationPinned FROM user WHERE id = ?",
        )
        .get(userId),
    request: (userId: string, organizationId: unknown) =>
      request(
        "PATCH",
        "/default-organization",
        { organizationId },
        { "x-test-user": userId },
      ),
  };
}
