import { describe, expect, it } from "bun:test";
import { reconcilePendingCheckoutEntitlements } from "./billingCheckoutSync";
import {
  createFixture,
  insertStalePendingCheckout,
  organizationId,
  reserveCheckout,
  sendWebhook,
  subscriptionEvent,
} from "./testing/billingFixture";
import { type FetchCall, withFetch } from "./testing/http";
import { insertBilling, seedOrganization } from "./testing/seed";

describe("billing checkout sync", () => {
  it("requires billing access to confirm a Checkout session", async () => {
    const fixture = createFixture("member");
    expect(
      (await fixture.request("/?session_id=cs_completed", undefined)).status,
    ).toBe(403);
  });

  it("reports a Checkout return without payment as incomplete", async () => {
    const fixture = createFixture();
    let reference = organizationId;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_returned_open?expand%5B%5D=subscription":
          async () =>
            Response.json({
              client_reference_id: reference,
              id: "cs_returned_open",
              status: "open",
              subscription: null,
            }),
      },
      async () => {
        const returned = await fixture.request(
          "/?session_id=cs_returned_open",
          undefined,
        );
        expect(returned.status).toBe(200);
        expect(await returned.json()).toMatchObject({
          checkout: "incomplete",
          plan: "free",
        });

        reference = "org_other";
        const foreign = await fixture.request(
          "/?session_id=cs_returned_open",
          undefined,
        );
        expect(foreign.status).toBe(409);
      },
    );
  });

  it("only lets verified Checkout replace the current subscription", async () => {
    const fixture = createFixture();
    const current = subscriptionEvent(
      "evt_current_subscription",
      100,
      "active",
      2,
      "sub_current",
    );
    const checkoutSubscription = subscriptionEvent(
      "unused_checkout_subscription_event",
      101,
      "active",
      3,
      "sub_checkout",
    );
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_checkout",
          subscription: "sub_checkout",
        },
      },
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
    };
    const oldSubscription = subscriptionEvent(
      "unused_old_subscription_event",
      102,
      "active",
      1,
      "sub_old",
    );
    const oldCheckout = {
      created: 102,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_old_checkout",
          subscription: "sub_old",
        },
      },
      id: "evt_old_checkout_completed",
      type: "checkout.session.completed",
    };
    let stripeSubscription = current.data.object;
    const requests: Array<{ method: string; url: string }> = [];
    const stripe = async (call: FetchCall) => {
      const request = { method: call.method, url: call.url };
      requests.push(request);
      if (request.method === "DELETE") {
        const canceled = request.url.endsWith("/sub_current")
          ? current.data.object
          : oldSubscription.data.object;
        return Response.json({ ...canceled, status: "canceled" });
      }
      return Response.json(stripeSubscription);
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_current": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_checkout": stripe,
        "DELETE https://api.stripe.com/v1/subscriptions/sub_current": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_old": stripe,
        "DELETE https://api.stripe.com/v1/subscriptions/sub_old": stripe,
      },
      async () => {
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        reserveCheckout(fixture.database, "cs_checkout");
        stripeSubscription = checkoutSubscription.data.object;
        expect((await sendWebhook(fixture, checkout)).status).toBe(200);
        stripeSubscription = oldSubscription.data.object;
        expect((await sendWebhook(fixture, oldCheckout)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT paid_ended_at, stripe_status, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          paid_ended_at: null,
          stripe_status: "active",
          stripe_subscription_id: "sub_checkout",
        });
        expect(requests).toEqual([
          {
            method: "GET",
            url: "https://api.stripe.com/v1/subscriptions/sub_current",
          },
          {
            method: "GET",
            url: "https://api.stripe.com/v1/subscriptions/sub_checkout",
          },
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_current",
          },
          {
            method: "GET",
            url: "https://api.stripe.com/v1/subscriptions/sub_old",
          },
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_old",
          },
        ]);
      },
    );
  });

  it("waits for a Checkout webhook before confirming its subscription", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_sync_race");
    const subscription = subscriptionEvent(
      "unused_sync_race",
      101,
      "active",
      1,
      "sub_sync_race",
    ).data.object;
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_sync_race",
          subscription: "sub_sync_race",
        },
      },
      id: "evt_sync_race",
      type: "checkout.session.completed",
    };
    let markSubscriptionFetchStarted = () => {};
    let markCheckoutFetched = () => {};
    let releaseSubscriptionFetch = () => {};
    const subscriptionFetchStarted = new Promise<void>((resolve) => {
      markSubscriptionFetchStarted = resolve;
    });
    const checkoutFetched = new Promise<void>((resolve) => {
      markCheckoutFetched = resolve;
    });
    const subscriptionFetchReleased = new Promise<void>((resolve) => {
      releaseSubscriptionFetch = resolve;
    });
    let subscriptionFetchCount = 0;
    const stripe = async (call: FetchCall) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/v1/checkout/sessions/cs_sync_race")) {
        markCheckoutFetched();
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_sync_race",
          status: "complete",
          subscription: "sub_sync_race",
        });
      }
      if (url.pathname.endsWith("/v1/subscriptions/sub_sync_race")) {
        subscriptionFetchCount += 1;
        markSubscriptionFetchStarted();
        await subscriptionFetchReleased;
        return Response.json(subscription);
      }
      throw new Error(`Unexpected Stripe request: ${url.href}`);
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_sync_race": stripe,
        "GET https://api.stripe.com/v1/checkout/sessions/cs_sync_race?expand%5B%5D=subscription":
          stripe,
      },
      async () => {
        try {
          const webhookResponse = sendWebhook(fixture, checkout);
          await subscriptionFetchStarted;
          const confirmationResponse = fixture.request(
            "/?session_id=cs_sync_race",
            undefined,
          );
          await checkoutFetched;
          releaseSubscriptionFetch();
          expect((await webhookResponse).status).toBe(200);
          const confirmation = await confirmationResponse;
          expect(confirmation.status).toBe(200);
          expect(await confirmation.json()).toMatchObject({
            checkout: "complete",
            plan: "pro",
          });
          expect(subscriptionFetchCount).toBe(1);
        } finally {
          releaseSubscriptionFetch();
        }
      },
    );
  });

  it("keeps the current subscription for an invalid Checkout price", async () => {
    const fixture = createFixture();
    const current = subscriptionEvent(
      "evt_price_current",
      100,
      "active",
      2,
      "sub_price_current",
    );
    const invalid = subscriptionEvent(
      "unused_price_invalid",
      101,
      "active",
      2,
      "sub_price_invalid",
      "price_other",
    );
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_price_invalid",
          subscription: "sub_price_invalid",
        },
      },
      id: "evt_price_checkout",
      type: "checkout.session.completed",
    };
    let stripeSubscription = current.data.object;
    const requests: Array<{ method: string; url: string }> = [];
    const stripe = async (call: FetchCall) => {
      const request = { method: call.method, url: call.url };
      requests.push(request);
      if (request.method === "DELETE") {
        return Response.json({ ...invalid.data.object, status: "canceled" });
      }
      return Response.json(stripeSubscription);
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_price_current": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_price_invalid": stripe,
        "DELETE https://api.stripe.com/v1/subscriptions/sub_price_invalid":
          stripe,
      },
      async () => {
        expect((await sendWebhook(fixture, current)).status).toBe(200);
        reserveCheckout(fixture.database, "cs_price_invalid");
        stripeSubscription = invalid.data.object;
        expect((await sendWebhook(fixture, checkout)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          pending_checkout_session_id: null,
          stripe_subscription_id: "sub_price_current",
        });
        expect(requests).toEqual([
          {
            method: "GET",
            url: "https://api.stripe.com/v1/subscriptions/sub_price_current",
          },
          {
            method: "GET",
            url: "https://api.stripe.com/v1/subscriptions/sub_price_invalid",
          },
          {
            method: "DELETE",
            url: "https://api.stripe.com/v1/subscriptions/sub_price_invalid",
          },
        ]);
      },
    );
  });

  it("rotates failed stale Checkout reconciliations beyond the batch", async () => {
    const fixture = createFixture();
    const sessions = new Map<string, string>();
    for (let index = 0; index < 26; index += 1) {
      const suffix = index === 25 ? "z" : index.toString().padStart(2, "0");
      const target = `org_pending_${suffix}`;
      const sessionId = `cs_pending_${suffix}`;
      const now = new Date().toISOString();
      seedOrganization(fixture.database, {
        createdAt: now,
        id: target,
        name: "Pending Checkout",
        slug: `pending-${suffix}`,
      });
      insertBilling(fixture.database, target, {
        pending_checkout_expires_at: 1,
        pending_checkout_session_id: sessionId,
        pending_checkout_url: "https://checkout.stripe.test/stale",
        updated_at: now,
      });
      sessions.set(sessionId, target);
    }
    const requests: string[] = [];
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_pending_*": async (
          call: FetchCall,
        ) => {
          const sessionId = call.url.split("/").at(-1) ?? "";
          requests.push(sessionId);
          const target = sessions.get(sessionId);
          if (!target)
            throw new Error(`Unexpected Checkout session: ${sessionId}`);
          if (sessionId !== "cs_pending_z") {
            return Response.json(
              { error: { message: "Stripe is unavailable" } },
              { status: 500 },
            );
          }
          return Response.json({
            client_reference_id: target,
            id: sessionId,
            status: "expired",
            subscription: null,
          });
        },
      },
      async () => {
        await reconcilePendingCheckoutEntitlements(fixture.bindings, 100);
        expect(requests).toHaveLength(25);
        expect(requests).not.toContain("cs_pending_z");
        expect(
          fixture.database
            .query(
              `SELECT COUNT(*) AS count FROM organization_billing
             WHERE pending_checkout_retry_at = 400`,
            )
            .get(),
        ).toEqual({ count: 25 });

        await reconcilePendingCheckoutEntitlements(fixture.bindings, 100);
        expect(requests.at(-1)).toBe("cs_pending_z");
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id
             FROM organization_billing WHERE organization_id = 'org_pending_z'`,
            )
            .get(),
        ).toEqual({ pending_checkout_session_id: null });
      },
      { captureErrors: true },
    );
  });
});
