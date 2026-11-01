import { describe, expect, it } from "bun:test";
import { findActivity } from "../shared/activity";
import {
  createFixture,
  organizationId,
  proPriceId,
  sendWebhook,
  subscriptionEvent,
} from "../testing/billingFixture";
import { type FetchCall, withFetch } from "../testing/http";
import { insertBilling } from "../testing/seed";
import type { SubscriptionCancellation } from "./billingCancellations";
import { storePendingCheckout } from "./billingCheckout";
import { cancelOrganizationSubscription } from "./billingDeletion";

type Fixture = ReturnType<typeof createFixture>;

const session = {
  client_reference_id: organizationId,
  expires_at: Math.floor(Date.now() / 1_000) + 1_800,
  id: "cs_activity_test",
  status: "open",
  url: "https://checkout.stripe.test/session",
};

function startedEvents(fixture: Fixture) {
  return fixture.database
    .query<
      {
        actor_user_id: string;
        details: string;
        root_id: string;
        root_label: string;
        root_type: string;
        subject_id: string;
      },
      []
    >(
      `SELECT actor_user_id, details, root_id, root_label, root_type, subject_id
       FROM activity_events WHERE action = 'billing.checkout_started'`,
    )
    .all()
    .map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
}

async function startCheckout(fixture: Fixture, requests: URLSearchParams[]) {
  return withFetch(
    {
      "POST https://api.stripe.com/v1/checkout/sessions": async (
        call: FetchCall,
      ) => {
        requests.push(new URLSearchParams(call.body));
        return Response.json(session);
      },
    },
    async () => fixture.request("/checkout", { method: "POST" }),
  );
}

describe("billing activity", () => {
  it("records who started Checkout once and names them to Stripe", async () => {
    const fixture = createFixture();
    const requests: URLSearchParams[] = [];
    expect((await startCheckout(fixture, requests)).status).toBe(200);
    expect(requests[0]?.get("metadata[started_by_user_id]")).toBe("user-1");
    expect(
      requests[0]?.get("subscription_data[metadata][started_by_user_id]"),
    ).toBe("user-1");
    const recorded = startedEvents(fixture);
    expect(recorded).toEqual([
      {
        actor_user_id: "user-1",
        details: {
          checkoutSessionId: "cs_activity_test",
          priceId: proPriceId,
          quantity: 1,
        },
        root_id: organizationId,
        root_label: expect.any(String),
        root_type: "organization_billing",
        subject_id: "cs_activity_test",
      },
    ]);
    // Resuming the open Checkout starts nothing new.
    expect((await startCheckout(fixture, requests)).status).toBe(200);
    expect(requests).toHaveLength(1);
    // Storing the same session again, as a retry would, records nothing more.
    expect(
      await storePendingCheckout(
        fixture.bindings.DB,
        organizationId,
        "unused-claim",
        { ...session, client_secret: null, customer: null, subscription: null },
        {
          actor: { userId: "user-1" },
          priceId: proPriceId,
          quantity: 1,
        },
      ),
    ).toBeTrue();
    expect(startedEvents(fixture)).toHaveLength(1);
  });

  it("shows billing activity only to owners and admins", async () => {
    const fixture = createFixture();
    await startCheckout(fixture, []);
    const read = (manager: boolean) =>
      findActivity(
        fixture.bindings.DB,
        organizationId,
        undefined,
        undefined,
        true,
        undefined,
        manager,
      );
    expect((await read(false))?.events).toEqual([]);
    expect((await read(true))?.events).toMatchObject([
      { action: "billing.checkout_started", actor: { id: "user-1" } },
    ]);
    const member = createFixture("member");
    expect((await member.request("/checkout", { method: "POST" })).status).toBe(
      403,
    );
    expect(startedEvents(member)).toEqual([]);
  });

  it("keeps no pending Checkout when its event cannot be recorded", async () => {
    const fixture = createFixture();
    fixture.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.checkout_started'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    expect((await startCheckout(fixture, [])).status).toBe(500);
    expect(
      fixture.database
        .query("SELECT pending_checkout_session_id FROM organization_billing")
        .get(),
    ).toEqual({ pending_checkout_session_id: null });
    expect(startedEvents(fixture)).toEqual([]);
  });
});

describe("billing portal activity", () => {
  const portalRoute = "POST https://api.stripe.com/v1/billing_portal/sessions";
  const portalSession = {
    id: "bps_activity_test",
    url: "https://billing.stripe.test/session/secret",
  };

  function withCustomer(fixture: Fixture) {
    insertBilling(fixture.database, organizationId, {
      stripe_customer_id: "cus_activity_test",
      updated_at: "2026-08-26T12:00:00.000Z",
    });
  }

  function portalEvents(fixture: Fixture) {
    return fixture.database
      .query<
        {
          actor_api_key_id: string | null;
          actor_user_id: string;
          details: string;
          root_type: string;
          subject_id: string;
        },
        []
      >(
        `SELECT actor_api_key_id, actor_user_id, details, root_type, subject_id
         FROM activity_events WHERE action = 'billing.portal_opened'`,
      )
      .all()
      .map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
  }

  const openPortal = (fixture: Fixture, response = portalSession) =>
    withFetch(
      { [portalRoute]: async () => Response.json(response) },
      async () => fixture.request("/portal", { method: "POST" }),
      { captureErrors: true },
    );

  it("records who opened each portal session, without its URL", async () => {
    const fixture = createFixture();
    withCustomer(fixture);
    const response = await openPortal(fixture);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: portalSession.url });
    expect(portalEvents(fixture)).toEqual([
      {
        actor_api_key_id: null,
        actor_user_id: "user-1",
        details: { portalSessionId: "bps_activity_test" },
        root_type: "organization_billing",
        subject_id: "bps_activity_test",
      },
    ]);
    expect(JSON.stringify(portalEvents(fixture))).not.toContain("secret");
    const read = (manager: boolean) =>
      findActivity(
        fixture.bindings.DB,
        organizationId,
        undefined,
        undefined,
        true,
        "organization_billing",
        manager,
      );
    expect((await read(false))?.events).toEqual([]);
    expect((await read(true))?.events).toMatchObject([
      { action: "billing.portal_opened", actor: { id: "user-1" } },
    ]);
    // Purging the organization removes it with the rest.
    fixture.database.run(
      `DELETE FROM organization WHERE id = '${organizationId}'`,
    );
    expect(portalEvents(fixture)).toEqual([]);
  });

  it("records nothing for members, organizations without a customer, or Stripe failures", async () => {
    const member = createFixture("member");
    withCustomer(member);
    expect((await openPortal(member)).status).toBe(403);
    expect(portalEvents(member)).toEqual([]);

    const noCustomer = createFixture();
    expect((await openPortal(noCustomer)).status).toBe(409);
    expect(portalEvents(noCustomer)).toEqual([]);

    const failing = createFixture();
    withCustomer(failing);
    const failed = await withFetch(
      {
        [portalRoute]: async () =>
          Response.json(
            { error: { message: "Stripe unavailable" } },
            {
              status: 503,
            },
          ),
      },
      async () => failing.request("/portal", { method: "POST" }),
      { captureErrors: true },
    );
    expect(failed.status).toBe(502);
    expect(portalEvents(failing)).toEqual([]);
  });

  it("hands out no session when the opener lost their role or recording fails", async () => {
    const demoted = createFixture();
    withCustomer(demoted);
    // The session's role says owner, but the stored membership no longer does.
    demoted.database.run(
      `UPDATE member SET role = 'member' WHERE organizationId = '${organizationId}' AND userId = 'user-1'`,
    );
    expect((await openPortal(demoted)).status).toBe(403);
    expect(portalEvents(demoted)).toEqual([]);

    const failing = createFixture();
    withCustomer(failing);
    failing.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.portal_opened'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const response = await openPortal(failing);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});

describe("subscription cancellation activity", () => {
  const deleting: SubscriptionCancellation = {
    actor: { userId: "user-1" },
    reason: "organization_deletion",
    via: "owner",
  };

  function paidFixture() {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 2,
      stripe_customer_id: "cus_test",
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_test",
      stripe_subscription_item_id: "si_test",
      updated_at: "2026-08-26T12:00:00.000Z",
    });
    return fixture;
  }

  function canceledEvents(fixture: Fixture) {
    return fixture.database
      .query<{ actor_user_id: string; details: string }, []>(
        `SELECT actor_user_id, details FROM activity_events
         WHERE action = 'billing.subscription_canceled'`,
      )
      .all()
      .map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
  }

  const intents = (fixture: Fixture) =>
    fixture.database
      .query("SELECT subscription_id FROM billing_cancellation_intents")
      .all();

  it("credits the deleter when the webhook persists a cancellation the request could not", async () => {
    const fixture = paidFixture();
    const canceled = subscriptionEvent("evt_canceled", 200, "canceled", 2);
    const object = {
      ...canceled.data.object,
      canceled_at: Math.floor(Date.now() / 1_000),
    };
    fixture.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.subscription_canceled'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(object),
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(object),
      },
      async ({ requests }) => {
        await expect(
          cancelOrganizationSubscription(
            fixture.bindings,
            organizationId,
            deleting,
          ),
        ).rejects.toThrow("activity unavailable");
        // Stripe canceled, but nothing was persisted or recorded.
        expect(
          fixture.database
            .query("SELECT stripe_status FROM organization_billing")
            .get(),
        ).toEqual({ stripe_status: "active" });
        expect(canceledEvents(fixture)).toEqual([]);
        expect(intents(fixture)).toEqual([{ subscription_id: "sub_test" }]);

        fixture.database.run("DROP TRIGGER fail_activity");
        expect(
          (await sendWebhook(fixture, { ...canceled, data: { object } }))
            .status,
        ).toBe(200);
        expect(canceledEvents(fixture)).toEqual([
          {
            actor_user_id: "user-1",
            details: {
              previousStatus: "active",
              reason: "organization_deletion",
              seatQuantity: 2,
              subscriptionId: "sub_test",
              via: "owner",
            },
          },
        ]);
        expect(intents(fixture)).toEqual([]);
        // Retrying the deletion skips the canceled subscription and records
        // nothing more.
        await cancelOrganizationSubscription(
          fixture.bindings,
          organizationId,
          deleting,
        );
        expect(
          requests.filter(({ method }) => method === "DELETE"),
        ).toHaveLength(1);
        expect(canceledEvents(fixture)).toHaveLength(1);
      },
      { captureErrors: true },
    );
  });

  it("credits whichever deleter's request Stripe shows canceled the subscription", async () => {
    const canceled = subscriptionEvent("evt_canceled", 200, "canceled", 2);
    const object = {
      ...canceled.data.object,
      canceled_at: Math.floor(Date.now() / 1_000),
    };
    const active = subscriptionEvent("evt_active", 100, "active", 2).data
      .object;
    const secondDeleter = { ...deleting, actor: { userId: "user-2" } };

    // A's request canceled, but its write failed; B retries before the
    // webhook. Stripe shows the subscription canceled, so A is credited.
    const first = paidFixture();
    first.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.subscription_canceled'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(object),
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(object),
      },
      async ({ requests }) => {
        await expect(
          cancelOrganizationSubscription(
            first.bindings,
            organizationId,
            deleting,
          ),
        ).rejects.toThrow("activity unavailable");
        first.database.run("DROP TRIGGER fail_activity");
        await cancelOrganizationSubscription(
          first.bindings,
          organizationId,
          secondDeleter,
        );
        expect(
          requests.filter(({ method }) => method === "DELETE"),
        ).toHaveLength(1);
        expect(canceledEvents(first)).toMatchObject([
          { actor_user_id: "user-1" },
        ]);
        // The webhook that follows records nothing more.
        await sendWebhook(first, { ...canceled, data: { object } });
        expect(canceledEvents(first)).toHaveLength(1);
        expect(intents(first)).toEqual([]);
      },
      { captureErrors: true },
    );

    // A's request failed without canceling; B's retry cancels, so B is.
    const second = paidFixture();
    let deletes = 0;
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": async () => {
          deletes += 1;
          return deletes === 1
            ? Response.json(
                { error: { message: "Stripe unavailable" } },
                { status: 503 },
              )
            : Response.json(object);
        },
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(active),
      },
      async () => {
        await expect(
          cancelOrganizationSubscription(
            second.bindings,
            organizationId,
            deleting,
          ),
        ).rejects.toThrow("Stripe unavailable");
        // An indeterminate failure keeps A's intent.
        expect(intents(second)).toEqual([{ subscription_id: "sub_test" }]);
        await cancelOrganizationSubscription(
          second.bindings,
          organizationId,
          secondDeleter,
        );
        expect(canceledEvents(second)).toMatchObject([
          { actor_user_id: "user-2" },
        ]);
      },
      { captureErrors: true },
    );
  });

  it("credits nobody for a cancellation long after a refused or stale intent", async () => {
    const fixture = paidFixture();
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(
            { error: { message: "No such subscription" } },
            { status: 404 },
          ),
      },
      async () => {
        await expect(
          cancelOrganizationSubscription(
            fixture.bindings,
            organizationId,
            deleting,
          ),
        ).rejects.toThrow("No such subscription");
      },
      { captureErrors: true },
    );
    // A definitive refusal leaves no intent behind.
    expect(intents(fixture)).toEqual([]);
    // An intent left by an indeterminate failure credits only a cancellation
    // Stripe reports close to it.
    fixture.database.run(`INSERT INTO billing_cancellation_intents
      (subscription_id, organization_id, actor_user_id, via, reason,
       previous_status, created_at)
      VALUES ('sub_test', '${organizationId}', 'user-1', 'owner',
              'organization_deletion', 'active',
              ${Math.floor(Date.now() / 1_000) - 86_400})`);
    const canceled = subscriptionEvent("evt_portal", 300, "canceled", 2);
    const object = {
      ...canceled.data.object,
      canceled_at: Math.floor(Date.now() / 1_000),
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(object),
      },
      async () => {
        expect(
          (await sendWebhook(fixture, { ...canceled, data: { object } }))
            .status,
        ).toBe(200);
      },
    );
    expect(canceledEvents(fixture)).toEqual([]);
    expect(intents(fixture)).toEqual([]);
    expect(
      fixture.database
        .query("SELECT stripe_status FROM organization_billing")
        .get(),
    ).toEqual({ stripe_status: "canceled" });
  });
});
