import { describe, expect, it, setSystemTime } from "bun:test";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import {
  createFixture,
  insertAudit,
  organizationId,
  proPriceId,
  reserveCheckout,
  sendWebhook,
  subscriptionEvent,
} from "./testing/billingFixture";
import { applyMigrations, createTestDatabase } from "./testing/database";
import { withFetch } from "./testing/http";
import { insertBilling, seedAccount } from "./testing/seed";

describe("billing subscriptions", () => {
  it("serializes concurrent same-second subscription refreshes", async () => {
    const fixture = createFixture();
    const active = subscriptionEvent("evt_concurrent_active", 100, "active", 1);
    const canceled = subscriptionEvent(
      "evt_concurrent_canceled",
      100,
      "canceled",
      1,
    );
    let currentSubscription = active.data.object;
    let releaseFirstFetch = () => {};
    let markFirstFetchStarted = () => {};
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCount = 0;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () => {
          fetchCount += 1;
          const snapshot = currentSubscription;
          if (fetchCount === 1) {
            markFirstFetchStarted();
            await firstFetchReleased;
          }
          return Response.json(snapshot);
        },
      },
      async () => {
        try {
          const firstResponse = sendWebhook(fixture, active);
          await firstFetchStarted;
          currentSubscription = canceled.data.object;
          const concurrentResponse = await sendWebhook(fixture, canceled);
          expect(concurrentResponse.status).toBe(500);
          releaseFirstFetch();
          expect((await firstResponse).status).toBe(200);
          expect((await sendWebhook(fixture, canceled)).status).toBe(200);
          expect(
            (
              await sendWebhook(
                fixture,
                subscriptionEvent("evt_same_second_retry", 100, "active", 1),
              )
            ).status,
          ).toBe(200);
          expect(
            fixture.database
              .query(
                `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
              )
              .get(organizationId),
          ).toEqual({ stripe_status: "canceled" });
        } finally {
          releaseFirstFetch();
        }
      },
    );
  });

  it("clears a Pro item after its price leaves the allowlist", async () => {
    const fixture = createFixture();
    let subscription = subscriptionEvent("evt_allowed_price", 100, "active", 1);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(subscription.data.object),
      },
      async () => {
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        subscription = subscriptionEvent(
          "evt_removed_price",
          101,
          "active",
          1,
          "sub_test",
          "price_removed",
        );
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT stripe_price_id, stripe_subscription_item_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          stripe_price_id: null,
          stripe_subscription_item_id: null,
        });
        expect(
          await (await fixture.request("/", undefined)).json(),
        ).toMatchObject({ plan: "free" });
      },
    );
  });

  it("starts the grace period when a paid subscription lapses", async () => {
    const fixture = createFixture();
    let subscription = subscriptionEvent("evt_paid", 100, "active", 1);
    const paidEndedAt = () =>
      (
        fixture.database
          .query(
            `SELECT paid_ended_at FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId) as { paid_ended_at: string | null }
      ).paid_ended_at;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(subscription.data.object),
      },
      async () => {
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        expect(paidEndedAt()).toBeNull();

        const beforeLapse = new Date().toISOString();
        subscription = subscriptionEvent("evt_lapsed", 101, "canceled", 1);
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        const lapsedAt = paidEndedAt();
        expect(lapsedAt).not.toBeNull();
        expect(String(lapsedAt) >= beforeLapse).toBe(true);
        insertAudit(
          fixture.database,
          "lapsed-old",
          organizationId,
          "2026-06-01",
        );
        expect(await purgeExpiredFreeAuditRuns(fixture.bindings)).toBe(0);

        // A stale event refetches Stripe's current state, so it neither clears
        // the marker nor moves the grace period forward.
        const staleUpdate = subscriptionEvent("evt_stale", 99, "active", 1);
        expect((await sendWebhook(fixture, staleUpdate)).status).toBe(200);
        // A minute later, so a rewritten marker could not match the first.
        setSystemTime(new Date(Date.parse(String(lapsedAt)) + 60_000));
        try {
          subscription = subscriptionEvent(
            "evt_lapsed_again",
            102,
            "canceled",
            1,
          );
          expect((await sendWebhook(fixture, subscription)).status).toBe(200);
          expect(paidEndedAt()).toBe(lapsedAt);
        } finally {
          setSystemTime();
        }

        subscription = subscriptionEvent("evt_resubscribed", 103, "active", 1);
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        expect(paidEndedAt()).toBeNull();
      },
    );
  });

  it("ends the grace period when Checkout starts a new subscription", async () => {
    const fixture = createFixture();
    let subscription = subscriptionEvent(
      "evt_before_lapse",
      100,
      "active",
      1,
      "sub_lapsed",
    );
    const stripe = async () => Response.json(subscription.data.object);
    const billingRow = () =>
      fixture.database
        .query(
          `SELECT paid_ended_at IS NOT NULL AS in_grace, stripe_status,
                  stripe_subscription_id
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId);
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_lapsed": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_resubscribed": stripe,
      },
      async () => {
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        subscription = subscriptionEvent(
          "evt_lapse",
          101,
          "canceled",
          1,
          "sub_lapsed",
        );
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        expect(billingRow()).toEqual({
          in_grace: 1,
          stripe_status: "canceled",
          stripe_subscription_id: "sub_lapsed",
        });

        reserveCheckout(fixture.database, "cs_resubscribe");
        subscription = subscriptionEvent(
          "unused_resubscribe",
          102,
          "active",
          1,
          "sub_resubscribed",
        );
        const checkout = {
          created: 102,
          data: {
            object: {
              client_reference_id: organizationId,
              id: "cs_resubscribe",
              subscription: "sub_resubscribed",
            },
          },
          id: "evt_resubscribe_checkout",
          type: "checkout.session.completed",
        };
        expect((await sendWebhook(fixture, checkout)).status).toBe(200);
        expect(billingRow()).toEqual({
          in_grace: 0,
          stripe_status: "active",
          stripe_subscription_id: "sub_resubscribed",
        });
      },
    );
  });

  it("ignores a replaced subscription's lapse for the grace period", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      stripe_customer_id: "cus_test",
      stripe_event_created: 100,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_current",
      stripe_subscription_item_id: "si_sub_current",
    });
    const replaced = subscriptionEvent(
      "evt_replaced_lapse",
      101,
      "canceled",
      1,
      "sub_replaced",
    );
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_replaced": async () =>
          Response.json(replaced.data.object),
      },
      async () => {
        expect((await sendWebhook(fixture, replaced)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT stripe_subscription_id, stripe_status, paid_ended_at
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          paid_ended_at: null,
          stripe_status: "active",
          stripe_subscription_id: "sub_current",
        });
      },
    );
  });

  it("backfills a grace period for organizations that already lapsed", async () => {
    const database = createTestDatabase({ before: "0053" });
    for (const id of ["user-1", "user-2", "user-3"])
      seedAccount(database, { id });
    const now = new Date().toISOString();
    insertBilling(database, "org_user-1", {
      stripe_status: "canceled",
      stripe_subscription_id: "sub_canceled",
      updated_at: now,
    });
    insertBilling(database, "org_user-2", {
      stripe_status: "active",
      stripe_subscription_id: "sub_active",
      updated_at: now,
    });
    insertBilling(database, "org_user-3", { updated_at: now });
    applyMigrations(database, { from: "0053" });

    const rows = database
      .query(
        `SELECT organization_id, paid_ended_at FROM organization_billing
         ORDER BY organization_id`,
      )
      .all() as { organization_id: string; paid_ended_at: string | null }[];
    expect(rows.map((row) => row.paid_ended_at !== null)).toEqual([
      true,
      false,
      false,
    ]);
    expect(String(rows[0]?.paid_ended_at) >= now).toBe(true);
  });
});
