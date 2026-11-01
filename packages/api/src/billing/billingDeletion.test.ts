import { describe, expect, it } from "bun:test";
import {
  createFixture,
  organizationId,
  proPriceId,
  subscriptionEvent,
} from "../testing/billingFixture";
import { type FetchCall, withFetch } from "../testing/http";
import { insertBilling } from "../testing/seed";
import { cancelOrganizationSubscription } from "./billingDeletion";
import type { SubscriptionCancellation } from "./billingSubscriptions";

const deleting: SubscriptionCancellation = {
  actor: { userId: "user-1" },
  reason: "organization_deletion",
  via: "owner",
};

describe("billing deletion", () => {
  it("invalidates an in-flight Checkout before organization deletion", async () => {
    const fixture = createFixture();
    let markCheckoutStarted = () => {};
    let releaseCheckout = () => {};
    const checkoutStarted = new Promise<void>((resolve) => {
      markCheckoutStarted = resolve;
    });
    const checkoutReleased = new Promise<void>((resolve) => {
      releaseCheckout = resolve;
    });
    const requests: string[] = [];
    const stripe = async (call: FetchCall) => {
      const url = call.url;
      requests.push(url);
      if (url.endsWith("/v1/checkout/sessions")) {
        markCheckoutStarted();
        await checkoutReleased;
        return Response.json({
          expires_at: Math.floor(Date.now() / 1_000) + 1_800,
          id: "cs_in_flight",
          status: "open",
          url: "https://checkout.stripe.test/in-flight",
        });
      }
      if (url.endsWith("/v1/checkout/sessions/cs_in_flight/expire")) {
        return Response.json({ id: "cs_in_flight", status: "expired" });
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    };
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": stripe,
        "POST https://api.stripe.com/v1/checkout/sessions/cs_in_flight/expire":
          stripe,
      },
      async () => {
        try {
          const checkoutResponse = fixture.request("/checkout", {
            method: "POST",
          });
          await checkoutStarted;
          expect(
            await cancelOrganizationSubscription(
              fixture.bindings,
              organizationId,
              deleting,
            ),
          ).toMatchObject({
            canceled: false,
            checkoutGuard: expect.any(String),
          });
          releaseCheckout();
          expect((await checkoutResponse).status).toBe(409);
          expect(requests).toEqual([
            "https://api.stripe.com/v1/checkout/sessions",
            "https://api.stripe.com/v1/checkout/sessions/cs_in_flight/expire",
          ]);
          expect(
            fixture.database
              .query(
                `SELECT checkout_disabled_at, pending_checkout_session_id
             FROM organization_billing WHERE organization_id = ?`,
              )
              .get(organizationId),
          ).toMatchObject({
            checkout_disabled_at: expect.any(String),
            pending_checkout_session_id: null,
          });
        } finally {
          releaseCheckout();
        }
      },
    );
  });

  it("skips terminal subscriptions during organization deletion", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      stripe_status: "incomplete_expired",
      stripe_subscription_id: "sub_incomplete_expired",
    });
    // No routes: any Stripe request fails the test.
    await withFetch({}, async ({ requests }) => {
      expect(
        await cancelOrganizationSubscription(
          fixture.bindings,
          organizationId,
          deleting,
        ),
      ).toMatchObject({ canceled: false, checkoutGuard: expect.any(String) });
      expect(requests).toEqual([]);
    });
  });

  it("fails closed when Stripe cannot find a subscription to cancel", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_wrong_account",
      stripe_subscription_item_id: "si_wrong_account",
    });
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_wrong_account":
          async () =>
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
        expect(
          fixture.database
            .query(
              `SELECT checkout_disabled_at, stripe_status
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ checkout_disabled_at: null, stripe_status: "active" });
      },
    );
  });

  it("reclaims a stale deletion lease after an interrupted worker", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      checkout_disabled_at: "interrupted-worker",
      checkout_disabled_expires_at: 1,
    });

    const result = await cancelOrganizationSubscription(
      fixture.bindings,
      organizationId,
      deleting,
    );
    expect(result).toMatchObject({
      canceled: false,
      checkoutGuard: expect.any(String),
    });
    expect(result.checkoutGuard).not.toBe("interrupted-worker");
    expect(
      fixture.database
        .query(
          `SELECT checkout_disabled_at, checkout_disabled_expires_at
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId),
    ).toEqual({
      checkout_disabled_at: result.checkoutGuard,
      checkout_disabled_expires_at: expect.any(Number),
    });
  });

  it("keeps concurrent organization deletions request-owned", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_delete_race",
      stripe_subscription_item_id: "si_sub_delete_race",
    });
    let markCancellationStarted = () => {};
    let releaseCancellation = () => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let requestCount = 0;
    await withFetch(
      {
        "DELETE https://api.stripe.com/v1/subscriptions/sub_delete_race":
          async () => {
            requestCount += 1;
            markCancellationStarted();
            await cancellationReleased;
            return Response.json(
              subscriptionEvent(
                "unused_delete_race",
                100,
                "canceled",
                1,
                "sub_delete_race",
              ).data.object,
            );
          },
      },
      async () => {
        try {
          const winner = cancelOrganizationSubscription(
            fixture.bindings,
            organizationId,
            deleting,
          );
          await cancellationStarted;
          await expect(
            cancelOrganizationSubscription(
              fixture.bindings,
              organizationId,
              deleting,
            ),
          ).rejects.toThrow("Organization deletion is already in progress.");
          releaseCancellation();
          const result = await winner;
          expect(requestCount).toBe(1);
          expect(
            fixture.database
              .query(
                `SELECT checkout_disabled_at FROM organization_billing
             WHERE organization_id = ?`,
              )
              .get(organizationId),
          ).toEqual({ checkout_disabled_at: result.checkoutGuard });
        } finally {
          releaseCancellation();
        }
      },
    );
  });
});
