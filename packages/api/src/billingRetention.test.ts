import { describe, expect, it } from "bun:test";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import {
  createFixture,
  insertAudit,
  insertStalePendingCheckout,
  organizationId,
  proPriceId,
  sendWebhook,
  subscriptionEvent,
} from "./testing/billingFixture";
import { type FetchCall, withFetch } from "./testing/http";
import { insertBilling } from "./testing/seed";

describe("billing retention", () => {
  it("purges old Free audit history without touching Pro history", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, "org_user-2", {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_retention_pro",
      stripe_subscription_item_id: "si_retention_pro",
    });
    insertBilling(fixture.database, "org_user-3", {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: "price_other",
      stripe_status: "active",
    });
    insertAudit(fixture.database, "free-old", organizationId, "2026-06-01");
    insertAudit(fixture.database, "free-recent", organizationId, "2026-08-20");
    insertAudit(fixture.database, "pro-old", "org_user-2", "2026-06-01");
    insertAudit(
      fixture.database,
      "other-price-old",
      "org_user-3",
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(1);
    expect(
      fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
    ).toEqual([
      { id: "free-recent" },
      { id: "other-price-old" },
      { id: "pro-old" },
    ]);
  });

  it("retains Pro history when a paid row is missing its subscription id", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
    });
    insertAudit(
      fixture.database,
      "partial-pro-row-old",
      organizationId,
      "2026-06-01",
    );

    const summary = await fixture.request("/", undefined);
    expect(await summary.json()).toMatchObject({ plan: "pro" });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "partial-pro-row-old" },
    ]);
  });

  it("retains history for an unresolved active Stripe price", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: "price_unknown",
      stripe_status: "active",
      stripe_subscription_id: "sub_unknown_price",
      stripe_subscription_item_id: "si_unknown_price",
    });
    insertAudit(
      fixture.database,
      "unknown-price-old",
      organizationId,
      "2026-06-01",
    );

    const summary = await fixture.request("/", undefined);
    expect(await summary.json()).toMatchObject({ plan: "free" });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "unknown-price-old" },
    ]);
  });

  it("keeps Pro history after the configured price rotates", async () => {
    const fixture = createFixture();
    let subscription = subscriptionEvent(
      "evt_before_price_rotation",
      100,
      "active",
      1,
    );
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(subscription.data.object),
      },
      async () => {
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        fixture.bindings.STRIPE_PRO_LEGACY_PRICE_IDS = proPriceId;
        fixture.bindings.STRIPE_PRO_PRICE_ID = "price_rotated";
        subscription = subscriptionEvent(
          "evt_after_price_rotation",
          101,
          "active",
          1,
        );
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        insertAudit(
          fixture.database,
          "rotated-price-pro-old",
          organizationId,
          "2026-06-01",
        );

        expect(
          await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
        ).toBe(0);
        expect(
          fixture.database
            .query(
              `SELECT stripe_price_id, stripe_subscription_item_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          stripe_price_id: proPriceId,
          stripe_subscription_item_id: "si_test",
        });
        expect(
          await (await fixture.request("/", undefined)).json(),
        ).toMatchObject({ plan: "pro" });
      },
    );
  });

  it("caps expired Free audit cleanup per invocation", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 605; index += 1) {
      insertAudit(
        fixture.database,
        `expired-${String(index).padStart(3, "0")}`,
        organizationId,
        "2026-06-01",
      );
    }
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(500);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM audits").get(),
    ).toEqual({ count: 105 });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(105);
  });

  it("keeps history while Checkout entitlement is unresolved", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      pending_checkout_expires_at: 2_000_000_000,
      pending_checkout_session_id: "cs_retention_race",
      pending_checkout_url: "https://checkout.stripe.test/retention-race",
    });
    insertAudit(
      fixture.database,
      "pending-checkout-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "pending-checkout-old" },
    ]);
  });

  it("keeps history while Checkout creation is in flight", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      checkout_claim_expires_at: 2_000_000_000,
      checkout_claim_id: "claim_retention_race",
      checkout_claim_quantity: 1,
    });
    insertAudit(
      fixture.database,
      "checkout-claim-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    fixture.database
      .query(
        `UPDATE organization_billing SET checkout_claim_expires_at = 1
         WHERE organization_id = ?`,
      )
      .run(organizationId);
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(1);
  });

  it("keeps lapsed paid history until the grace period ends", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      paid_ended_at: "2026-08-01T00:00:00.000Z",
      stripe_status: "canceled",
      stripe_subscription_id: "sub_lapsed",
    });
    insertBilling(fixture.database, "org_user-2", {
      stripe_status: "incomplete_expired",
      stripe_subscription_id: "sub_never_paid",
    });
    insertAudit(fixture.database, "lapsed-old", organizationId, "2026-06-01");
    insertAudit(fixture.database, "never-paid-old", "org_user-2", "2026-06-01");
    insertAudit(fixture.database, "no-billing-old", "org_user-3", "2026-06-01");

    expect(
      await purgeExpiredFreeAuditRuns(
        fixture.bindings,
        "2026-07-27",
        "2026-08-01T00:00:00.000Z",
      ),
    ).toBe(2);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "lapsed-old" },
    ]);
    expect(
      await purgeExpiredFreeAuditRuns(
        fixture.bindings,
        "2026-07-27",
        "2026-08-01T00:00:01.000Z",
      ),
    ).toBe(1);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([]);
  });

  it("keeps history while organization deletion is in flight", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      checkout_disabled_at: "deletion-in-flight",
      checkout_disabled_expires_at: 2_000_000_000,
      stripe_status: "canceled",
    });
    insertAudit(
      fixture.database,
      "deletion-in-flight-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "deletion-in-flight-old" },
    ]);
  });

  it("reconciles a completed stale Checkout before retention", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_complete");
    insertAudit(
      fixture.database,
      "completed-checkout-old",
      organizationId,
      "2026-06-01",
    );
    const stripe = async (call: FetchCall) => {
      const url = call.url;
      if (url.endsWith("/v1/checkout/sessions/cs_retention_complete")) {
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_retention_complete",
          status: "complete",
          subscription: "sub_retention_complete",
        });
      }
      if (url.endsWith("/v1/subscriptions/sub_retention_complete")) {
        return Response.json(
          subscriptionEvent(
            "evt_retention_complete",
            100,
            "active",
            1,
            "sub_retention_complete",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_retention_complete":
          stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_retention_complete":
          stripe,
      },
      async () => {
        expect(
          await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
        ).toBe(0);
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id, stripe_price_id,
                    stripe_status
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          pending_checkout_session_id: null,
          stripe_price_id: proPriceId,
          stripe_status: "active",
        });
        expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
          { id: "completed-checkout-old" },
        ]);
      },
    );
  });

  it("clears an expired stale Checkout before retention", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_expired");
    insertAudit(
      fixture.database,
      "expired-checkout-old",
      organizationId,
      "2026-06-01",
    );
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_retention_expired":
          async () =>
            Response.json({
              client_reference_id: organizationId,
              id: "cs_retention_expired",
              status: "expired",
              subscription: null,
            }),
      },
      async () => {
        expect(
          await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
        ).toBe(1);
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ pending_checkout_session_id: null });
      },
    );
  });

  it("expires an abandoned stale Checkout before retention", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_abandoned");
    insertAudit(
      fixture.database,
      "abandoned-checkout-old",
      organizationId,
      "2026-06-01",
    );
    const requests: string[] = [];
    const stripe = async (call: FetchCall) => {
      const url = call.url;
      requests.push(url);
      return Response.json({
        client_reference_id: organizationId,
        expires_at: 1,
        id: "cs_retention_abandoned",
        status: requests.length === 1 ? "open" : "expired",
        subscription: null,
      });
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned":
          stripe,
        "POST https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned/expire":
          stripe,
      },
      async () => {
        expect(
          await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
        ).toBe(1);
        expect(requests).toEqual([
          "https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned",
          "https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned/expire",
        ]);
      },
    );
  });

  it("isolates failed Checkout reconciliation during retention", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_failed");
    insertAudit(
      fixture.database,
      "failed-checkout-old",
      organizationId,
      "2026-06-01",
    );
    insertAudit(fixture.database, "other-free-old", "org_user-2", "2026-06-01");
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_retention_failed":
          async () =>
            Response.json(
              { error: { message: "Stripe is unavailable" } },
              { status: 500 },
            ),
      },
      async () => {
        expect(
          await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
        ).toBe(1);
        expect(
          fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
        ).toEqual([{ id: "failed-checkout-old" }]);
      },
      { captureErrors: true },
    );
  });

  it("fails closed when retention billing configuration is missing", async () => {
    const fixture = createFixture();
    insertAudit(fixture.database, "must-retain", organizationId, "2026-06-01");
    const { STRIPE_PRO_PRICE_ID: _priceId, ...missingPriceBindings } =
      fixture.bindings;
    await expect(
      purgeExpiredFreeAuditRuns(missingPriceBindings, "2026-07-27"),
    ).rejects.toThrow(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "must-retain" },
    ]);
  });

  it("keeps old audit runs that are still in progress", async () => {
    const fixture = createFixture();
    insertAudit(fixture.database, "active-old", organizationId, "2026-06-01");
    fixture.database
      .query(
        `UPDATE audits SET status = 'in_progress', completed_at = NULL
         WHERE id = 'active-old'`,
      )
      .run();
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "active-old" },
    ]);
  });
});
