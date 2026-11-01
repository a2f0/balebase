import type { Database } from "bun:sqlite";
import { describe, expect, it, setSystemTime } from "bun:test";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { withFetch } from "../testing/http";
import { insertBilling, seedAccount, seedMember } from "../testing/seed";
import { testApp } from "../testing/session";
import { organizationSettings } from "./organizationSettings";

const targetOrganizationId = "org_owner-user";
const fallbackOrganizationId = "org_member-user";
const proPriceId = "price_pro_test";

describe("organization deletion", () => {
  it("only lets an organization owner delete the organization", async () => {
    const fixture = createFixture();
    const response = await fixture
      .app("member-user", "member")
      .request("/current", { method: "DELETE" });

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Only an organization owner can delete this organization.",
    });
    expect(
      fixture.database
        .query("SELECT deletedAt FROM organization WHERE id = ?")
        .get(targetOrganizationId),
    ).toEqual({ deletedAt: null });
  });

  it("soft-deletes the organization and redirects active pointers", async () => {
    const fixture = createFixture();
    const response = await fixture
      .app("owner-user", "owner")
      .request("/current", { method: "DELETE" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedAt: string;
      organizationId: string;
    };
    expect(body.organizationId).toBe(targetOrganizationId);
    expect(new Date(body.deletedAt).toISOString()).toBe(body.deletedAt);
    // Recorded before the pending invitation was canceled, with the owner.
    expect(lifecycleEvents(fixture.database)).toEqual([
      {
        action: "organization.deletion_requested",
        actor_user_id: "owner-user",
        details: { canceledInvitations: 1, via: "owner" },
        occurred_at: body.deletedAt,
        root_label: expect.any(String),
      },
    ]);
    // Repeating it changes and records nothing, even in the same millisecond.
    setSystemTime(new Date(body.deletedAt));
    try {
      expect(
        (
          await fixture
            .app("owner-user", "owner")
            .request("/current", { method: "DELETE" })
        ).status,
      ).toBe(409);
    } finally {
      setSystemTime();
    }
    expect(lifecycleEvents(fixture.database)).toHaveLength(1);
    expect(
      fixture.database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = ?`,
        )
        .get(targetOrganizationId),
    ).toEqual({
      deletedAt: body.deletedAt,
      deletedByUserId: "owner-user",
    });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM member WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 2 });
    expect(
      fixture.database
        .query("SELECT status FROM invitation WHERE id = ?")
        .get("pending-invitation"),
    ).toEqual({ status: "canceled" });
    expect(
      fixture.database
        .query(
          `SELECT activeOrganizationId, activeTeamId
           FROM session WHERE userId = ?`,
        )
        .get("owner-user"),
    ).toEqual({
      activeOrganizationId: fallbackOrganizationId,
      activeTeamId: null,
    });

    const listing = await fixture
      .app("owner-user", "owner")
      .request("/organizations");
    const listingBody: unknown = await listing.json();
    expect(listingBody).toEqual({
      organizations: [
        {
          id: fallbackOrganizationId,
          name: "member-user's Organization",
        },
      ],
    });

    fixture.database
      .query("DELETE FROM organization WHERE id = ?")
      .run(targetOrganizationId);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM member WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM invitation WHERE organizationId = ?",
        )
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM team WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM user WHERE id IN (?, ?)")
        .get("owner-user", "member-user"),
    ).toEqual({ count: 2 });
  });

  it("cancels paid billing before an owner deletes the organization", async () => {
    const fixture = createFixture();
    insertPaidBilling(fixture.database, targetOrganizationId);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": () =>
          Response.json(canceledSubscription(targetOrganizationId)),
      },
      async ({ requests }) => {
        const response = await fixture
          .app("owner-user", "owner")
          .request("/current", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_test",
          },
        ]);
        expect(
          fixture.database
            .query(
              `SELECT organization.deletedAt, organization_billing.stripe_status
               FROM organization
               JOIN organization_billing
                 ON organization_billing.organization_id = organization.id
               WHERE organization.id = ?`,
            )
            .get(targetOrganizationId),
        ).toMatchObject({
          deletedAt: expect.any(String),
          stripe_status: "canceled",
        });
      },
    );
  });

  it("expires an open Checkout before an owner deletes the organization", async () => {
    const fixture = createFixture();
    insertPendingCheckout(fixture.database, "cs_pending_open");
    const session = (status: string) => () =>
      Response.json({ id: "cs_pending_open", status, subscription: null });
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_pending_open":
          session("open"),
        "POST https://api.stripe.com/v1/checkout/sessions/cs_pending_open/expire":
          session("expired"),
      },
      async ({ requests }) => {
        const response = await fixture
          .app("owner-user", "owner")
          .request("/current", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
          {
            method: "GET",
            url: "https://api.stripe.com/v1/checkout/sessions/cs_pending_open",
          },
          {
            method: "POST",
            url: "https://api.stripe.com/v1/checkout/sessions/cs_pending_open/expire",
          },
        ]);
        expect(
          fixture.database
            .query(
              `SELECT checkout_disabled_at, pending_checkout_session_id
               FROM organization_billing WHERE organization_id = ?`,
            )
            .get(targetOrganizationId),
        ).toMatchObject({
          checkout_disabled_at: expect.any(String),
          pending_checkout_session_id: null,
        });
      },
    );
  });

  it("cancels a completed pending Checkout before owner deletion", async () => {
    const fixture = createFixture();
    insertPendingCheckout(fixture.database, "cs_pending_complete");
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_pending_complete":
          () =>
            Response.json({
              id: "cs_pending_complete",
              status: "complete",
              subscription: "sub_pending",
            }),
        "DELETE https://api.stripe.com/v1/subscriptions/sub_pending": () =>
          Response.json(
            canceledSubscription(targetOrganizationId, "sub_pending"),
          ),
      },
      async ({ requests }) => {
        const response = await fixture
          .app("owner-user", "owner")
          .request("/current", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
          {
            method: "GET",
            url: "https://api.stripe.com/v1/checkout/sessions/cs_pending_complete",
          },
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_pending",
          },
        ]);
        expect(
          fixture.database
            .query(
              `SELECT stripe_status, stripe_subscription_id
               FROM organization_billing WHERE organization_id = ?`,
            )
            .get(targetOrganizationId),
        ).toEqual({
          stripe_status: "canceled",
          stripe_subscription_id: "sub_pending",
        });
      },
    );
  });

  it("keeps a paid organization when owner cancellation fails", async () => {
    const fixture = createFixture();
    insertPaidBilling(fixture.database, targetOrganizationId);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": () =>
          Response.json(
            { error: { message: "Stripe unavailable" } },
            { status: 503 },
          ),
      },
      async () => {
        const response = await fixture
          .app("owner-user", "owner")
          .request("/current", { method: "DELETE" });
        expect(response.status).toBe(502);
        expect(lifecycleEvents(fixture.database)).toEqual([]);
        expect(
          fixture.database
            .query(
              `SELECT organization.deletedAt,
                      organization_billing.checkout_disabled_at
               FROM organization
               JOIN organization_billing
                 ON organization_billing.organization_id = organization.id
               WHERE organization.id = ?`,
            )
            .get(targetOrganizationId),
        ).toEqual({ checkout_disabled_at: null, deletedAt: null });
      },
      { captureErrors: true },
    );
  });

  it("re-enables checkout when deletion storage fails after cancellation", async () => {
    const fixture = createFixture();
    insertPaidBilling(fixture.database, targetOrganizationId);
    fixture.database.exec(
      `CREATE TRIGGER fail_owner_organization_deletion
       BEFORE UPDATE OF deletedAt ON organization
       WHEN NEW.deletedAt IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'forced organization deletion failure');
       END`,
    );
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": () =>
          Response.json(canceledSubscription(targetOrganizationId)),
      },
      async () => {
        const response = await fixture
          .app("owner-user", "owner")
          .request("/current", { method: "DELETE" });
        expect(response.status).toBe(500);
        expect(lifecycleEvents(fixture.database)).toEqual([]);
        expect(
          fixture.database
            .query(
              `SELECT organization.deletedAt,
                      organization_billing.checkout_disabled_at,
                      organization_billing.stripe_status
               FROM organization
               JOIN organization_billing
                 ON organization_billing.organization_id = organization.id
               WHERE organization.id = ?`,
            )
            .get(targetOrganizationId),
        ).toEqual({
          checkout_disabled_at: null,
          deletedAt: null,
          stripe_status: "canceled",
        });
      },
      { captureErrors: true },
    );
  });
});

describe("organization member security", () => {
  it("lets a manager require two-factor authentication per member", async () => {
    const fixture = createFixture();
    const response = await fixture
      .app("owner-user", "owner")
      .request("/people/target-member/two-factor-required", {
        body: JSON.stringify({ required: true }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      memberId: "target-member",
      required: true,
    });
    const invalid = await fixture
      .app("owner-user", "owner")
      .request("/people/target-member/two-factor-required", {
        body: JSON.stringify({ required: "yes" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "A required boolean is required.",
    });
    expect(
      fixture.database
        .query("SELECT twoFactorRequired FROM member WHERE id = ?")
        .get("target-member"),
    ).toEqual({ twoFactorRequired: 1 });

    const listing = await fixture.app("owner-user", "owner").request("/people");
    const body = (await listing.json()) as {
      members: Array<{
        id: string;
        twoFactorEnabled: boolean;
        twoFactorRequired: boolean;
      }>;
    };
    expect(body.members.find(({ id }) => id === "target-member")).toMatchObject(
      {
        twoFactorEnabled: false,
        twoFactorRequired: true,
      },
    );
  });

  it("identifies the signed-in member and when each member joined", async () => {
    const fixture = createFixture();
    const listing = await fixture
      .app("member-user", "member")
      .request("/people");
    expect(listing.status).toBe(200);
    const body = (await listing.json()) as {
      currentMemberId: string | null;
      members: Array<Record<string, unknown>>;
    };
    expect(body.currentMemberId).toBe("target-member");
    expect(body.members).toContainEqual({
      id: "target-member",
      joinedAt: "2026-08-20T12:00:00.000Z",
      role: "member",
      user: {
        email: "member-user@example.com",
        id: "member-user",
        name: "member-user",
      },
    });
    const ownerListing = await fixture
      .app("owner-user", "owner")
      .request("/people");
    const ownerBody = (await ownerListing.json()) as {
      currentMemberId: string | null;
    };
    expect(ownerBody.currentMemberId).toBe("member_owner-user");
  });

  it("shows managers, but not members, when each member was last active", async () => {
    const fixture = createFixture();
    fixture.database
      .query("UPDATE user SET lastActiveAt = ? WHERE id = ?")
      .run("2026-10-15T08:30:00.000Z", "member-user");

    const ownerListing = await fixture
      .app("owner-user", "owner")
      .request("/people");
    const ownerBody = (await ownerListing.json()) as {
      members: Array<Record<string, unknown>>;
    };
    expect(
      ownerBody.members.find(({ id }) => id === "target-member"),
    ).toMatchObject({ lastActiveAt: "2026-10-15T08:30:00.000Z" });

    const memberListing = await fixture
      .app("member-user", "member")
      .request("/people");
    const memberBody = (await memberListing.json()) as {
      members: Array<Record<string, unknown>>;
    };
    for (const listedMember of memberBody.members) {
      expect(listedMember).not.toHaveProperty("lastActiveAt");
    }
  });

  it("rejects member changes from non-managers", async () => {
    const fixture = createFixture();
    const response = await fixture
      .app("member-user", "member")
      .request("/people/target-member/two-factor-required", {
        body: JSON.stringify({ required: true }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Organization manager access required.",
    });
  });

  it("does not update a member from another organization", async () => {
    const fixture = createFixture();
    const response = await fixture
      .app("owner-user", "owner")
      .request("/people/fallback-member/two-factor-required", {
        body: JSON.stringify({ required: true }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Organization member not found.",
    });
  });
});

/** The organization's deletion history, oldest first. */
function lifecycleEvents(database: Database) {
  return (
    database
      .query(
        `SELECT action, actor_user_id, details, occurred_at, root_label
         FROM activity_events
         WHERE root_type = 'organization' AND root_id = ? ORDER BY id`,
      )
      .all(targetOrganizationId) as {
      action: string;
      actor_user_id: string;
      details: string;
      occurred_at: string;
      root_label: string;
    }[]
  ).map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
}

function createFixture() {
  const database = createTestDatabase();
  seedAccount(database, { createdAt: now(), id: "owner-user" });
  seedAccount(database, { createdAt: now(), id: "member-user" });
  seedMember(database, {
    createdAt: now(),
    id: "target-member",
    organizationId: targetOrganizationId,
    userId: "member-user",
  });
  seedMember(database, {
    createdAt: now(),
    id: "fallback-member",
    organizationId: fallbackOrganizationId,
    userId: "owner-user",
  });
  database
    .query(
      `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
    )
    .run(
      "pending-invitation",
      targetOrganizationId,
      "invited@example.com",
      "2026-08-30T12:00:00.000Z",
      now(),
      "owner-user",
    );
  insertSession(database, "owner-user", targetOrganizationId);
  insertSession(database, "member-user", targetOrganizationId);
  const bindings = testBindings({
    DB: toD1(database),
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
  });
  return {
    app: (userId: string, organizationRole: string) => {
      const app = testApp(
        { "/": organizationSettings },
        { organizationId: targetOrganizationId, organizationRole, userId },
      );
      return {
        request: (path: string, init?: RequestInit) =>
          app.request(path, init, bindings),
      };
    },
    database,
  };
}

function insertPaidBilling(database: Database, organizationId: string) {
  insertBilling(database, organizationId, {
    seat_quantity: 2,
    stripe_customer_id: "cus_test",
    stripe_event_created: 1,
    stripe_price_id: proPriceId,
    stripe_status: "active",
    stripe_subscription_id: "sub_test",
    stripe_subscription_item_id: "si_test",
    updated_at: now(),
  });
}

function insertPendingCheckout(database: Database, sessionId: string) {
  insertBilling(database, targetOrganizationId, {
    pending_checkout_expires_at: 2_000_000_000,
    pending_checkout_session_id: sessionId,
    pending_checkout_url: "https://checkout.stripe.test/pending",
    updated_at: now(),
  });
}
function canceledSubscription(
  organizationId: string,
  subscriptionId = "sub_test",
) {
  return {
    cancel_at_period_end: false,
    customer: "cus_test",
    id: subscriptionId,
    items: {
      data: [
        {
          id: "si_test",
          price: { id: proPriceId },
          quantity: 2,
        },
      ],
    },
    metadata: { organization_id: organizationId },
    status: "canceled",
  };
}

function insertSession(
  database: Database,
  userId: string,
  activeOrganizationId: string,
) {
  database
    .query(
      `INSERT INTO session
       (id, expiresAt, token, createdAt, updatedAt, userId,
        activeOrganizationId, activeTeamId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `session-${userId}`,
      "2027-08-20T12:00:00.000Z",
      `token-${userId}`,
      now(),
      now(),
      userId,
      activeOrganizationId,
      `team_finance_${activeOrganizationId}`,
    );
}

function now() {
  return "2026-08-20T12:00:00.000Z";
}
