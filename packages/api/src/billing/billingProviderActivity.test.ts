import { describe, expect, it } from "bun:test";
import { findActivity } from "../shared/activity";
import {
  createFixture,
  organizationId,
  proPriceId,
  reserveCheckout,
  sendWebhook,
  subscriptionEvent,
} from "../testing/billingFixture";
import { type FetchCall, withFetch } from "../testing/http";
import { insertBilling, seedMember } from "../testing/seed";
import {
  reconcileSubscriptionSeats,
  syncOrganizationSeats,
} from "./billingSeats";

type Fixture = ReturnType<typeof createFixture>;

interface ProviderEvent {
  actor_name: string;
  actor_source: string | null;
  actor_type: string;
  actor_user_id: string | null;
  causation_id: string | null;
  causation_type: string | null;
  details: Record<string, unknown>;
  root_id: string;
  root_type: string;
  subject_id: string;
}

function events(fixture: Fixture, action: string) {
  return fixture.database
    .query<Omit<ProviderEvent, "details"> & { details: string }, [string]>(
      `SELECT actor_name, actor_source, actor_type, actor_user_id,
              causation_id, causation_type, details, root_id, root_type,
              subject_id
       FROM activity_events WHERE action = ? ORDER BY id`,
    )
    .all(action)
    .map(
      (row): ProviderEvent => ({
        ...row,
        details: JSON.parse(row.details) as Record<string, unknown>,
      }),
    );
}

const periodEnd = new Date(1_800_000_000 * 1_000).toISOString();

function stored(subscriptionId: string, status: string, seats: number) {
  return {
    cancelAtPeriodEnd: false,
    periodEnd,
    priceId: proPriceId,
    seats,
    status,
    subscriptionId,
  };
}

function billingRow(fixture: Fixture) {
  return fixture.database
    .query(
      `SELECT stripe_status, seat_quantity FROM organization_billing
       WHERE organization_id = ?`,
    )
    .get(organizationId);
}

function proBilling(fixture: Fixture, seats = 1) {
  insertBilling(fixture.database, organizationId, {
    current_period_end: periodEnd,
    seat_quantity: seats,
    stripe_customer_id: "cus_test",
    stripe_event_created: 1,
    stripe_price_id: proPriceId,
    stripe_status: "active",
    stripe_subscription_id: "sub_test",
    stripe_subscription_item_id: "si_test",
  });
}

describe("Stripe subscription history", () => {
  it("records each change Stripe reports, by Stripe, once per event", async () => {
    const fixture = createFixture();
    let current = subscriptionEvent("evt_active", 100, "active", 3);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(current.data.object),
      },
      async () => {
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        expect(events(fixture, "billing.subscription_changed")).toEqual([
          {
            actor_name: "Stripe",
            actor_source: "stripe",
            actor_type: "provider",
            actor_user_id: null,
            causation_id: "evt_active",
            causation_type: "stripe_event",
            details: {
              after: stored("sub_test", "active", 3),
              before: null,
              stripeEventId: "evt_active",
              subscriptionId: "sub_test",
            },
            root_id: organizationId,
            root_type: "organization_billing",
            subject_id: "sub_test",
          },
        ]);
        // A redelivery, and another event that changes nothing, record nothing.
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        expect(
          (
            await sendWebhook(fixture, {
              ...current,
              id: "evt_invoice_paid",
            })
          ).status,
        ).toBe(200);
        expect(events(fixture, "billing.subscription_changed")).toHaveLength(1);

        current = subscriptionEvent("evt_canceled", 101, "canceled", 3);
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        expect(billingRow(fixture)).toEqual({
          seat_quantity: 3,
          stripe_status: "canceled",
        });
        expect(
          events(fixture, "billing.subscription_changed")[1],
        ).toMatchObject({
          actor_user_id: null,
          causation_id: "evt_canceled",
          details: {
            after: stored("sub_test", "canceled", 3),
            before: stored("sub_test", "active", 3),
            stripeEventId: "evt_canceled",
          },
        });
      },
    );
  });

  it("stores no newer state for a redelivered event without its history", async () => {
    const fixture = createFixture();
    let current = subscriptionEvent("evt_active", 100, "active", 3);
    const stripe = {
      "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
        Response.json(current.data.object),
    };
    await withFetch(stripe, async () => {
      expect((await sendWebhook(fixture, current)).status).toBe(200);
      // Its receipt could not be marked processed, so Stripe redelivers it
      // after the subscription changed again.
      fixture.database.run("DELETE FROM stripe_webhook_events");
      const redelivered = current;
      current = subscriptionEvent("evt_canceled", 101, "canceled", 3);
      expect((await sendWebhook(fixture, redelivered)).status).toBe(200);
      expect(billingRow(fixture)).toEqual({
        seat_quantity: 3,
        stripe_status: "active",
      });
      expect(events(fixture, "billing.subscription_changed")).toHaveLength(1);
      // Stripe's own event for the change stores and records it.
      expect((await sendWebhook(fixture, current)).status).toBe(200);
    });
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 3,
      stripe_status: "canceled",
    });
    expect(
      events(fixture, "billing.subscription_changed").map(
        (event) => event.causation_id,
      ),
    ).toEqual(["evt_active", "evt_canceled"]);
  });

  it("keeps the stored subscription when its event cannot be recorded", async () => {
    const fixture = createFixture();
    proBilling(fixture);
    fixture.database.exec(`CREATE TRIGGER fail_subscription_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.subscription_changed'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const canceled = subscriptionEvent("evt_canceled", 101, "canceled", 1);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(canceled.data.object),
      },
      async () => {
        const response = await sendWebhook(fixture, canceled);
        expect(response.status).toBe(500);
      },
    );
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 1,
      stripe_status: "active",
    });
    // The receipt is released, so Stripe's retry processes it again.
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("links Checkout's subscription and records the one it replaced", async () => {
    const fixture = createFixture();
    const current = subscriptionEvent(
      "evt_current",
      100,
      "active",
      2,
      "sub_current",
    );
    const replacement = subscriptionEvent(
      "unused",
      101,
      "active",
      3,
      "sub_new",
    );
    let subscription = current.data.object;
    const stripe = async (call: FetchCall) =>
      call.method === "DELETE"
        ? Response.json({ ...current.data.object, status: "canceled" })
        : Response.json(subscription);
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_current": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_current": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_new": stripe,
      },
      async () => {
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        reserveCheckout(fixture.database, "cs_new");
        subscription = replacement.data.object;
        const completed = {
          created: 101,
          data: {
            object: {
              client_reference_id: organizationId,
              id: "cs_new",
              subscription: "sub_new",
            },
          },
          id: "evt_checkout_completed",
          type: "checkout.session.completed",
        };
        expect((await sendWebhook(fixture, completed)).status).toBe(200);
      },
    );
    const changes = events(fixture, "billing.subscription_changed");
    expect(changes.map((event) => event.subject_id)).toEqual([
      "sub_current",
      "sub_current",
      "sub_new",
    ]);
    expect(changes[1]).toMatchObject({
      actor_type: "provider",
      actor_user_id: null,
      causation_id: "evt_checkout_completed",
      details: {
        after: stored("sub_current", "canceled", 2),
        before: stored("sub_current", "active", 2),
        checkoutSessionId: "cs_new",
        reason: "replaced",
        replacedBySubscriptionId: "sub_new",
      },
    });
    expect(changes[2]).toMatchObject({
      causation_id: "evt_checkout_completed",
      details: {
        after: stored("sub_new", "active", 3),
        before: stored("sub_current", "canceled", 2),
        checkoutSessionId: "cs_new",
      },
    });
  });

  it("records a Checkout the person confirms, linked to its session", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      pending_checkout_expires_at: 2_000_000_000,
      pending_checkout_session_id: "cs_confirmed",
      pending_checkout_url: "https://checkout.stripe.test/pending",
    });
    const subscription = subscriptionEvent("unused", 100, "active", 1);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_confirmed*":
          async () =>
            Response.json({
              client_reference_id: organizationId,
              id: "cs_confirmed",
              status: "complete",
              subscription: subscription.data.object,
            }),
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(subscription.data.object),
      },
      async () => {
        const confirmed = await fixture.request("/?session_id=cs_confirmed");
        expect(confirmed.status).toBe(200);
      },
    );
    expect(events(fixture, "billing.subscription_changed")).toMatchObject([
      {
        actor_type: "provider",
        actor_user_id: null,
        causation_id: "cs_confirmed",
        causation_type: "stripe_checkout_session",
        details: {
          after: stored("sub_test", "active", 1),
          before: null,
          checkoutSessionId: "cs_confirmed",
        },
      },
    ]);
  });

  it("shows subscription history only to owners and admins", async () => {
    const fixture = createFixture();
    const active = subscriptionEvent("evt_active", 100, "active", 1);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(active.data.object),
      },
      async () => {
        await sendWebhook(fixture, active);
      },
    );
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
      {
        action: "billing.subscription_changed",
        actor: { email: "", id: null, source: "stripe", type: "provider" },
      },
    ]);
  });
});

describe("Stripe seat history", () => {
  it("records a membership's seat change by Stripe, keyed by its request", async () => {
    const fixture = createFixture();
    proBilling(fixture);
    seedMember(fixture.database, {
      createdAt: new Date().toISOString(),
      organizationId,
      userId: "user-2",
    });
    const keys: (string | null)[] = [];
    await withFetch(
      {
        "POST https://api.stripe.com/v1/subscription_items/si_test": async (
          call: FetchCall,
        ) => {
          keys.push(call.headers.get("idempotency-key"));
          return Response.json({ id: "si_test", quantity: 2 });
        },
      },
      async () => {
        expect(
          await syncOrganizationSeats(fixture.bindings, organizationId),
        ).toBe(true);
        // The count is unchanged now: nothing is sent or recorded.
        expect(
          await syncOrganizationSeats(fixture.bindings, organizationId),
        ).toBe(false);
      },
    );
    expect(keys).toHaveLength(1);
    expect(events(fixture, "billing.seats_changed")).toEqual([
      {
        actor_name: "Stripe",
        actor_source: "stripe",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: keys[0] ?? "missing",
        causation_type: "stripe_request",
        details: {
          after: 2,
          before: 1,
          source: "membership",
          subscriptionId: "sub_test",
        },
        root_id: organizationId,
        root_type: "organization_billing",
        subject_id: "sub_test",
      },
    ]);
  });

  it("records nothing when Stripe refuses the seat change", async () => {
    const fixture = createFixture();
    proBilling(fixture);
    seedMember(fixture.database, {
      createdAt: new Date().toISOString(),
      organizationId,
      userId: "user-2",
    });
    await withFetch(
      {
        "POST https://api.stripe.com/v1/subscription_items/si_test": async () =>
          Response.json({ error: { message: "No." } }, { status: 400 }),
      },
      async () => {
        await expect(
          syncOrganizationSeats(fixture.bindings, organizationId),
        ).rejects.toThrow();
      },
    );
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 1,
      stripe_status: "active",
    });
    expect(events(fixture, "billing.seats_changed")).toEqual([]);
  });

  it("records reconciliation's seat changes with its job run", async () => {
    const fixture = createFixture();
    proBilling(fixture, 3);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscription_items/si_test": async () =>
          Response.json({ id: "si_test", quantity: 1 }),
      },
      async () => {
        await reconcileSubscriptionSeats(fixture.bindings, "run-1");
        // A second run finds nothing to change.
        await reconcileSubscriptionSeats(fixture.bindings, "run-2");
      },
    );
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 1,
      stripe_status: "active",
    });
    expect(events(fixture, "billing.seats_changed")).toMatchObject([
      {
        actor_type: "provider",
        actor_user_id: null,
        causation_id: "run-1",
        causation_type: "job_run",
        details: { after: 1, before: 3, source: "reconciliation" },
      },
    ]);
  });

  it("leaves a redelivered run's newer quantity to the next run", async () => {
    const fixture = createFixture();
    proBilling(fixture, 3);
    let stripeQuantity = 1;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscription_items/si_test": async () =>
          Response.json({ id: "si_test", quantity: stripeQuantity }),
      },
      async () => {
        await reconcileSubscriptionSeats(fixture.bindings, "run-1");
        seedMember(fixture.database, {
          createdAt: new Date().toISOString(),
          organizationId,
          userId: "user-2",
        });
        stripeQuantity = 2;
        await reconcileSubscriptionSeats(fixture.bindings, "run-1");
        expect(billingRow(fixture)).toEqual({
          seat_quantity: 1,
          stripe_status: "active",
        });
        await reconcileSubscriptionSeats(fixture.bindings, "run-2");
      },
    );
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 2,
      stripe_status: "active",
    });
    expect(events(fixture, "billing.seats_changed")).toMatchObject([
      { causation_id: "run-1", details: { after: 1, before: 3 } },
      { causation_id: "run-2", details: { after: 2, before: 1 } },
    ]);
  });

  it("keeps the stored seats when their event cannot be recorded", async () => {
    const fixture = createFixture();
    proBilling(fixture, 3);
    fixture.database.exec(`CREATE TRIGGER fail_seat_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'billing.seats_changed'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscription_items/si_test": async () =>
          Response.json({ id: "si_test", quantity: 1 }),
      },
      async () => {
        await expect(
          reconcileSubscriptionSeats(fixture.bindings, "run-1"),
        ).rejects.toThrow("activity unavailable");
      },
    );
    expect(billingRow(fixture)).toEqual({
      seat_quantity: 3,
      stripe_status: "active",
    });
  });
});
