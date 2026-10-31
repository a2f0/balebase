import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { findActivity } from "../shared/activity";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { withFetch } from "../testing/http";
import { insertBilling, seedAccount, seedMember } from "../testing/seed";
import { testApp } from "../testing/session";
import type { Bindings } from "../types";
import { adminOrganizations } from "./adminOrganizations";

const proPriceId = "price_pro_test";
const targetOrganizationId = "org_member-user";

interface OrganizationDetailResponse {
  organization: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  requirements: Array<
    Record<string, unknown> & { checkrReportUrl: string | null }
  >;
}

describe("admin organizations", () => {
  it("opens another organization's people and checks without joining it", async () => {
    const database = createDetailFixture();
    database
      .query(
        "DELETE FROM member WHERE userId = 'user-1' AND organizationId = ?",
      )
      .run(targetOrganizationId);
    database
      .query("UPDATE user SET lastActiveAt = ? WHERE id = 'member-user'")
      .run("2026-10-15T08:30:00.000Z");
    const response = await adminApp(database).request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.organization).toMatchObject({
      id: targetOrganizationId,
      memberCount: 1,
      name: "Member Person's Organization",
      plaidItemCount: 0,
    });
    expect(body.members).toEqual([
      {
        id: "member_member-user",
        joinedAt: expect.any(String),
        lastActiveAt: "2026-10-15T08:30:00.000Z",
        role: "owner",
        twoFactorEnabled: false,
        twoFactorRequired: false,
        user: {
          id: "member-user",
          email: "member@example.com",
          name: "Member Person",
        },
      },
    ]);
    expect(body.requirements).toEqual([
      {
        id: "background-check",
        kind: "background_check",
        title: "Background check",
        dueDate: "2026-10-31",
        status: "complete",
        targetEmail: "member@example.com",
        targetName: "Member Person",
        completedAt: "2026-10-07T11:09:18.000Z",
        checkrStatus: "complete",
        checkrResult: "clear",
        checkrReportUrl:
          "https://dashboard.checkrhq-staging.net/reports/report%2F1",
      },
    ]);
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM member WHERE userId = 'user-1' AND organizationId = ?",
        )
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      database
        .query(
          "SELECT activeOrganizationId FROM session WHERE id = 'member-session'",
        )
        .get(),
    ).toEqual({ activeOrganizationId: targetOrganizationId });
  });

  it("uses the production Checkr dashboard for production reports", async () => {
    const database = createDetailFixture();
    const response = await adminApp(database, "production").request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.requirements[0]?.checkrReportUrl).toBe(
      "https://dashboard.checkr.com/reports/report%2F1",
    );
  });

  it("keeps an unstarted check viewable after its member is removed", async () => {
    const database = createDetailFixture();
    database
      .query(
        "UPDATE employee_requirements SET checkr_report_id = NULL, checkr_result = NULL, checkr_report_status = NULL, status = 'pending', completed_at = NULL WHERE id = 'background-check'",
      )
      .run();
    database.query("DELETE FROM member WHERE id = 'member_member-user'").run();
    const response = await adminApp(database).request(
      `/${targetOrganizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrganizationDetailResponse;
    expect(body.requirements[0]).toMatchObject({
      targetEmail: "original@example.com",
      targetName: null,
      checkrReportUrl: null,
      checkrResult: null,
      status: "pending",
    });
  });

  it("returns not found for an unknown organization detail page", async () => {
    const database = createDeletionFixture();
    const response = await adminApp(database).request("/missing");
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "Organization not found." });
  });

  it("lists organizations with their owners and member counts", async () => {
    const database = createTestDatabase();
    seedAccount(database, {
      email: "person@example.com",
      emailVerified: false,
      id: "user-1",
      name: "Example Person",
      role: "admin",
    });

    const response = await adminApp(database).request("/");

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizations: [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
          deletedAt: null,
          id: "org_user-1",
          memberCount: 1,
          name: "Example Person's Organization",
          ownerEmail: "person@example.com",
          ownerName: "Example Person",
          plaidItemCount: 0,
          slug: "personal-user-1",
        },
      ],
    });
  });

  it("counts connected Plaid items per organization independently of accounts and members", async () => {
    const database = createDetailFixture();
    const now = "2026-10-17T12:00:00.000Z";
    for (const [id, organizationId, status] of [
      ["active-item", targetOrganizationId, "active"],
      ["error-item", targetOrganizationId, "error"],
      ["disconnected-item", targetOrganizationId, "disconnected"],
      ["other-item", "org_user-1", "active"],
    ]) {
      database
        .query(
          `INSERT INTO plaid_items
           (id, organization_id, plaid_item_id, access_token_ciphertext,
            access_token_iv, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, '', '', ?, 'user-1', ?, ?)`,
        )
        .run(id ?? "", organizationId ?? "", id ?? "", status ?? "", now, now);
    }
    for (const id of ["checking", "savings", "credit-card"]) {
      database
        .query(
          `INSERT INTO plaid_accounts
           (id, organization_id, plaid_item_record_id, plaid_account_id,
            name, type, updated_at)
           VALUES (?, ?, 'active-item', ?, ?, 'depository', ?)`,
        )
        .run(id, targetOrganizationId, id, id, now);
    }
    const app = adminApp(database);
    const list = await app.request("/");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      organizations: Array<Record<string, unknown>>;
    };
    expect(body.organizations).toHaveLength(2);
    expect(body.organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targetOrganizationId,
          memberCount: 2,
          plaidItemCount: 2,
        }),
        expect.objectContaining({
          id: "org_user-1",
          memberCount: 1,
          plaidItemCount: 1,
        }),
      ]),
    );
    const detail = await app.request(`/${targetOrganizationId}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as OrganizationDetailResponse;
    expect(detailBody.organization).toMatchObject({
      id: targetOrganizationId,
      memberCount: 2,
      plaidItemCount: 2,
    });
  });

  it("marks an organization for deletion and records the admin", async () => {
    const database = createDeletionFixture();
    const response = await adminApp(database).request("/org_member-user", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedAt: string;
      deletedByEmail: string;
      deletedByName: string;
      deletedByUserId: string;
      organizationId: string;
    };
    expect(body).toEqual({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      organizationId: "org_member-user",
    });
    expect(new Date(body.deletedAt).toISOString()).toBe(body.deletedAt);
    expect(
      database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = ?`,
        )
        .get("org_member-user"),
    ).toEqual({
      deletedAt: body.deletedAt,
      deletedByUserId: "user-1",
    });

    const listing = await adminApp(database).request("/");
    const listingBody = (await listing.json()) as {
      organizations: Array<Record<string, unknown>>;
    };
    expect(listingBody.organizations[0]).toMatchObject({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      id: "org_member-user",
    });
  });

  it("returns not found without creating billing for an unknown organization", async () => {
    const database = createDeletionFixture();
    const response = await adminApp(database).request("/org_missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM organization_billing
           WHERE organization_id = 'org_missing'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("cancels paid billing before an admin deletes the organization", async () => {
    const database = createDeletionFixture();
    insertPaidBilling(database);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_admin_test": () =>
          Response.json(canceledSubscription()),
      },
      async ({ requests }) => {
        const response = await adminApp(database).request(
          `/${targetOrganizationId}`,
          { method: "DELETE" },
        );
        expect(response.status).toBe(200);
        expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_admin_test",
          },
        ]);
        expect(
          database
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

  it("keeps a paid organization when admin cancellation fails", async () => {
    const database = createDeletionFixture();
    insertPaidBilling(database);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_admin_test": () =>
          Response.json(
            { error: { message: "Stripe unavailable" } },
            { status: 503 },
          ),
      },
      async () => {
        const response = await adminApp(database).request(
          `/${targetOrganizationId}`,
          { method: "DELETE" },
        );
        expect(response.status).toBe(502);
        expect(
          database
            .query("SELECT deletedAt FROM organization WHERE id = ?")
            .get(targetOrganizationId),
        ).toEqual({ deletedAt: null });
      },
      { captureErrors: true },
    );
  });

  it("re-enables checkout when deletion storage fails after cancellation", async () => {
    const database = createDeletionFixture();
    insertPaidBilling(database);
    database.exec(
      `CREATE TRIGGER fail_admin_organization_deletion
       BEFORE UPDATE OF deletedAt ON organization
       WHEN NEW.deletedAt IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'forced organization deletion failure');
       END`,
    );
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_admin_test": () =>
          Response.json(canceledSubscription()),
      },
      async () => {
        const response = await adminApp(database).request(
          `/${targetOrganizationId}`,
          { method: "DELETE" },
        );
        expect(response.status).toBe(500);
        expect(
          database
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

  it("records who deleted and restored an organization, for root admins and its managers", async () => {
    const database = createDeletionFixture();
    seedAccount(database, {
      email: "second@example.com",
      id: "admin-2",
      name: "Second Admin",
      role: "admin",
    });
    const first = adminApp(database);
    const second = adminApp(database, "staging", "admin-2");
    expect(
      (await first.request("/org_member-user", { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await second.request("/org_member-user/restore", { method: "POST" }))
        .status,
    ).toBe(200);
    // Restoring an active organization records nothing.
    expect(
      (await second.request("/org_member-user/restore", { method: "POST" }))
        .status,
    ).toBe(409);
    expect(
      (await second.request("/org_member-user", { method: "DELETE" })).status,
    ).toBe(200);
    // Deleting it again records nothing either.
    expect(
      (await first.request("/org_member-user", { method: "DELETE" })).status,
    ).toBe(409);

    const detail = await first.request("/org_member-user");
    const { history } = (await detail.json()) as HistoryResponse;
    expect(
      history.map(({ action, actor, details }) => ({
        action,
        actor: actor.id,
        details,
      })),
    ).toEqual([
      {
        action: "organization.deletion_requested",
        actor: "admin-2",
        details: { canceledInvitations: 0, via: "root_admin" },
      },
      {
        action: "organization.restored",
        actor: "admin-2",
        details: {
          deletedAt: expect.any(String),
          deletedByEmail: "person@example.com",
          deletedById: "user-1",
          deletedByName: "Example Person",
          via: "root_admin",
        },
      },
      {
        action: "organization.deletion_requested",
        actor: "user-1",
        details: { canceledInvitations: 0, via: "root_admin" },
      },
    ]);
    // The organization's own feed keeps it for managers only.
    const managerFeed = await findActivity(
      toD1(database),
      targetOrganizationId,
      undefined,
      undefined,
      false,
      "organization",
      true,
    );
    expect(managerFeed?.events).toHaveLength(3);
    const memberFeed = await findActivity(
      toD1(database),
      targetOrganizationId,
      undefined,
      undefined,
      false,
      "organization",
      false,
    );
    expect(memberFeed?.events).toEqual([]);
  });

  it("keeps an organization deleted when its restoration cannot be recorded", async () => {
    const database = createDeletionFixture();
    const admin = adminApp(database);
    expect(
      (await admin.request("/org_member-user", { method: "DELETE" })).status,
    ).toBe(200);
    database.exec(`CREATE TRIGGER reject_activity
      BEFORE INSERT ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const response = await admin.request("/org_member-user/restore", {
      method: "POST",
    });
    expect(response.status).toBe(500);
    database.exec("DROP TRIGGER reject_activity");
    expect(
      database
        .query(
          "SELECT deletedByUserId FROM organization WHERE id = 'org_member-user'",
        )
        .get(),
    ).toEqual({ deletedByUserId: "user-1" });
    const { history } = (await (
      await admin.request("/org_member-user")
    ).json()) as HistoryResponse;
    expect(history.map(({ action }) => action)).toEqual([
      "organization.deletion_requested",
    ]);
  });

  it("restores a deleted organization without overriding other defaults", async () => {
    const database = createDeletionFixture();
    const deletion = await adminApp(database).request("/org_member-user", {
      method: "DELETE",
    });
    expect(deletion.status).toBe(200);
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'member-user'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: null });
    expect(
      database
        .query(
          `SELECT activeOrganizationId
           FROM session WHERE userId = 'member-user'`,
        )
        .get(),
    ).toEqual({ activeOrganizationId: null });

    const response = await adminApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizationId: "org_member-user",
    });
    expect(
      database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ deletedAt: null, deletedByUserId: null });
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'member-user'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: "org_member-user" });
    expect(
      database
        .query(
          `SELECT activeOrganizationId, activeTeamId
           FROM session WHERE userId = 'member-user'`,
        )
        .get(),
    ).toEqual({
      activeOrganizationId: "org_member-user",
      activeTeamId: null,
    });
    expect(
      database
        .query(
          `SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ checkout_disabled_at: null });
    expect(
      database
        .query(
          `SELECT defaultOrganizationId
           FROM user WHERE id = 'user-1'`,
        )
        .get(),
    ).toEqual({ defaultOrganizationId: "org_user-1" });

    const repeated = await adminApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(repeated.status).toBe(409);
    database
      .query(
        `UPDATE organization_billing
         SET checkout_disabled_at = 'concurrent-deletion'
         WHERE organization_id = 'org_member-user'`,
      )
      .run();
    const concurrent = await adminApp(database).request(
      "/org_member-user/restore",
      { method: "POST" },
    );
    expect(concurrent.status).toBe(409);
    expect(
      database
        .query(
          `SELECT checkout_disabled_at FROM organization_billing
           WHERE organization_id = 'org_member-user'`,
        )
        .get(),
    ).toEqual({ checkout_disabled_at: "concurrent-deletion" });
  });
});

interface HistoryResponse {
  history: Array<{
    action: string;
    actor: { id: string; name: string };
    details: Record<string, unknown>;
  }>;
}

function createDeletionFixture() {
  const database = createTestDatabase();
  seedAccount(database, {
    email: "person@example.com",
    id: "user-1",
    name: "Example Person",
    role: "admin",
  });
  seedAccount(database, {
    email: "member@example.com",
    id: "member-user",
    name: "Member Person",
  });
  seedMember(database, {
    id: "admin-target-membership",
    organizationId: "org_member-user",
    userId: "user-1",
  });
  database
    .query(
      `INSERT INTO session
       (id, expiresAt, token, createdAt, updatedAt, userId,
        activeOrganizationId, activeTeamId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "member-session",
      "2027-08-18T12:00:00.000Z",
      "member-token",
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
      "member-user",
      "org_member-user",
      "team_finance_org_member-user",
    );
  return database;
}

function createDetailFixture() {
  const database = createDeletionFixture();
  database
    .query(
      `INSERT INTO employee_requirements
     (id, organization_id, member_id, target_email, kind, title, due_date, status,
      created_at, updated_at, completed_at, checkr_report_id, checkr_result,
      checkr_report_status)
     VALUES ('background-check', ?, 'member_member-user', 'original@example.com',
             'background_check', 'Background check', '2026-10-31', 'complete',
             '2026-10-07T11:00:00.000Z', '2026-10-07T11:09:18.000Z',
             '2026-10-07T11:09:18.000Z', 'report/1', 'clear', 'complete')`,
    )
    .run(targetOrganizationId);
  database
    .query(
      `INSERT INTO employee_requirements
     (id, organization_id, target_email, kind, title, due_date, created_at, updated_at)
     VALUES ('other-check', 'org_user-1', 'person@example.com', 'credit_check',
             'Private other check', '2026-10-01', '2026-10-01', '2026-10-01')`,
    )
    .run();
  return database;
}

function adminApp(
  database: Database,
  checkrEnv: Bindings["CHECKR_ENV"] = "staging",
  userId = "user-1",
) {
  const app = testApp(
    { "/": adminOrganizations },
    {
      email: "person@example.com",
      name: "Example Person",
      role: "admin",
      userId,
    },
  );
  const bindings = testBindings({
    CHECKR_ENV: checkrEnv,
    DB: toD1(database),
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
  });
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

function insertPaidBilling(database: Database) {
  insertBilling(database, targetOrganizationId, {
    seat_quantity: 1,
    stripe_customer_id: "cus_admin_test",
    stripe_event_created: 1,
    stripe_price_id: proPriceId,
    stripe_status: "active",
    stripe_subscription_id: "sub_admin_test",
    stripe_subscription_item_id: "si_admin_test",
    updated_at: "2026-08-26T12:00:00.000Z",
  });
}
function canceledSubscription() {
  return {
    cancel_at_period_end: false,
    customer: "cus_admin_test",
    id: "sub_admin_test",
    items: {
      data: [
        {
          id: "si_admin_test",
          price: { id: proPriceId },
          quantity: 1,
        },
      ],
    },
    metadata: { organization_id: targetOrganizationId },
    status: "canceled",
  };
}
