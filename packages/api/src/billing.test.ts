import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { billing } from "./billing";
import { reconcilePendingCheckoutEntitlements } from "./billingCheckoutSync";
import { cancelOrganizationSubscription } from "./billingDeletion";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import {
  reconcileSubscriptionSeats,
  syncOrganizationSeats,
} from "./billingSeats";
import {
  handleStripeWebhook,
  purgeStripeWebhookReceipts,
} from "./billingWebhook";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { applyMigrations, createTestDatabase } from "./testing/database";
import { type FetchCall, withFetch } from "./testing/http";
import {
  insertBilling,
  seedAccount,
  seedMember,
  seedOrganization,
  seedUser,
} from "./testing/seed";
import { testApp } from "./testing/session";
import type { Bindings } from "./types";

const organizationId = "org_user-1";
const proPriceId = "price_pro_test";

describe("billing", () => {
  it("requires billing access to confirm a Checkout session", async () => {
    const fixture = createFixture("member");
    expect(
      (await fixture.request("/?session_id=cs_completed", undefined)).status,
    ).toBe(403);
  });

  it("reports Free entitlements and creates per-seat Checkout", async () => {
    const fixture = createFixture();
    const summary = await fixture.request("/", undefined);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      current: { formTemplates: 0, members: 1 },
      limits: { formTemplates: 5, retentionDays: 30, users: 1 },
      plan: "free",
      pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
      seats: 1,
    });

    const checkoutRequests: URLSearchParams[] = [];
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async (
          call: FetchCall,
        ) => {
          checkoutRequests.push(new URLSearchParams(call.body));
          return Response.json({
            client_reference_id: organizationId,
            expires_at: Math.floor(Date.now() / 1_000) + 1_800,
            id: "cs_live_test",
            status: "open",
            url: "https://checkout.stripe.test/session",
          });
        },
      },
      async () => {
        const response = await fixture.request("/checkout", { method: "POST" });
        expect(response.status).toBe(200);
        const checkoutBody: unknown = await response.json();
        expect(checkoutBody).toEqual({
          url: "https://checkout.stripe.test/session",
        });
        expect(checkoutRequests[0]?.get("line_items[0][price]")).toBe(
          proPriceId,
        );
        expect(checkoutRequests[0]?.get("line_items[0][quantity]")).toBe("1");
        expect(checkoutRequests[0]?.get("client_reference_id")).toBe(
          organizationId,
        );
        expect(
          checkoutRequests[0]?.get(
            "subscription_data[metadata][organization_id]",
          ),
        ).toBe(organizationId);
        const repeated = await fixture.request("/checkout", { method: "POST" });
        const repeatedBody: unknown = await repeated.json();
        expect(repeatedBody).toEqual({
          url: "https://checkout.stripe.test/session",
        });
        expect(checkoutRequests).toHaveLength(1);
      },
    );
  });

  it("creates and resumes inline Checkout with a publishable key", async () => {
    const fixture = createFixture();
    const bindings = {
      ...fixture.bindings,
      STRIPE_PUBLISHABLE_KEY: "pk_live_test",
    };
    const requests: Array<{
      body: URLSearchParams;
      method: string;
      url: string;
    }> = [];
    const session = {
      client_reference_id: organizationId,
      client_secret: "cs_inline_test_secret_123",
      expires_at: Math.floor(Date.now() / 1_000) + 1_800,
      id: "cs_inline_test",
      status: "open",
      url: null,
    };
    const stripe = async (call: FetchCall) => {
      requests.push({
        body: new URLSearchParams(call.body),
        method: call.method,
        url: call.url,
      });
      return Response.json(session);
    };
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": stripe,
        "GET https://api.stripe.com/v1/checkout/sessions/cs_inline_test":
          stripe,
      },
      async () => {
        const response = await fixture.app.request(
          "/checkout",
          { method: "POST" },
          bindings,
        );
        expect(response.status).toBe(200);
        const createdBody: unknown = await response.json();
        expect(createdBody).toEqual({
          clientSecret: "cs_inline_test_secret_123",
          publishableKey: "pk_live_test",
        });
        const created = requests[0]?.body;
        expect(created?.get("ui_mode")).toBe("elements");
        expect(created?.get("return_url")).toBe(
          "https://app.balebase.test/organization/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        );
        expect(created?.get("customer_email")).toBe("user-1@example.com");
        expect(created?.has("success_url")).toBe(false);
        expect(created?.has("cancel_url")).toBe(false);
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id, pending_checkout_url
             FROM organization_billing`,
            )
            .get(),
        ).toEqual({
          pending_checkout_session_id: "cs_inline_test",
          pending_checkout_url: null,
        });

        const resumed = await fixture.app.request(
          "/checkout",
          { method: "POST" },
          bindings,
        );
        expect(resumed.status).toBe(200);
        const resumedBody: unknown = await resumed.json();
        expect(resumedBody).toEqual({
          clientSecret: "cs_inline_test_secret_123",
          publishableKey: "pk_live_test",
        });
        expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "POST https://api.stripe.com/v1/checkout/sessions",
          "GET https://api.stripe.com/v1/checkout/sessions/cs_inline_test",
        ]);

        session.status = "complete";
        const finished = await fixture.app.request(
          "/checkout",
          { method: "POST" },
          bindings,
        );
        expect(finished.status).toBe(409);
        expect(requests).toHaveLength(3);
      },
    );
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

  it("keeps hosted Checkout when the publishable key mode differs", async () => {
    const fixture = createFixture();
    const checkoutRequests: URLSearchParams[] = [];
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async (
          call: FetchCall,
        ) => {
          checkoutRequests.push(new URLSearchParams(call.body));
          return Response.json({
            client_reference_id: organizationId,
            expires_at: Math.floor(Date.now() / 1_000) + 1_800,
            id: "cs_hosted_test",
            status: "open",
            url: "https://checkout.stripe.test/hosted",
          });
        },
      },
      async () => {
        const response = await fixture.app.request(
          "/checkout",
          { method: "POST" },
          { ...fixture.bindings, STRIPE_PUBLISHABLE_KEY: "pk_test_other" },
        );
        const hostedBody: unknown = await response.json();
        expect(hostedBody).toEqual({
          url: "https://checkout.stripe.test/hosted",
        });
        expect(checkoutRequests[0]?.has("ui_mode")).toBe(false);
        expect(checkoutRequests[0]?.has("customer_email")).toBe(false);
        expect(checkoutRequests[0]?.get("success_url")).toContain(
          "checkout=success",
        );
      },
    );
  });

  it("reconciles an expired local Checkout before replacing it", async () => {
    const fixture = createFixture();
    insertStalePendingCheckout(fixture.database, "cs_completed_at_expiry");
    const requests: string[] = [];
    const stripe = async (call: FetchCall) => {
      const url = call.url;
      requests.push(url);
      if (url.endsWith("/v1/checkout/sessions/cs_completed_at_expiry")) {
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_completed_at_expiry",
          status: "complete",
          subscription: "sub_completed_at_expiry",
        });
      }
      if (url.endsWith("/v1/subscriptions/sub_completed_at_expiry")) {
        return Response.json(
          subscriptionEvent(
            "evt_completed_at_expiry",
            100,
            "active",
            1,
            "sub_completed_at_expiry",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/checkout/sessions/cs_completed_at_expiry":
          stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_completed_at_expiry":
          stripe,
      },
      async () => {
        const response = await fixture.request("/checkout", { method: "POST" });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
          error: "This organization already has a Pro subscription.",
        });
        expect(requests).toEqual([
          "https://api.stripe.com/v1/checkout/sessions/cs_completed_at_expiry",
          "https://api.stripe.com/v1/subscriptions/sub_completed_at_expiry",
        ]);
        expect(
          fixture.database
            .query(
              `SELECT pending_checkout_session_id, stripe_subscription_id,
                    stripe_status
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          pending_checkout_session_id: null,
          stripe_status: "active",
          stripe_subscription_id: "sub_completed_at_expiry",
        });
      },
    );
  });

  it("reclaims a stale deletion lease before creating Checkout", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      checkout_disabled_at: "interrupted-worker",
      checkout_disabled_expires_at: 1,
    });
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async () =>
          Response.json({
            client_reference_id: organizationId,
            expires_at: Math.floor(Date.now() / 1_000) + 1_800,
            id: "cs_after_interrupted_deletion",
            status: "open",
            url: "https://checkout.stripe.test/recovered",
          }),
      },
      async () => {
        const response = await fixture.request("/checkout", { method: "POST" });
        expect(response.status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT checkout_disabled_at, checkout_disabled_expires_at
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          checkout_disabled_at: null,
          checkout_disabled_expires_at: null,
        });
      },
    );
  });

  it("allows only the database claimant to create Checkout", async () => {
    const fixture = createFixture();
    const idempotencyKeys: string[] = [];
    let markRequestStarted = () => {};
    let releaseRequest = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async (
          call: FetchCall,
        ) => {
          idempotencyKeys.push(call.headers.get("Idempotency-Key") ?? "");
          markRequestStarted();
          await requestReleased;
          const parameters = new URLSearchParams(call.body);
          return Response.json({
            expires_at: Number(parameters.get("expires_at")),
            id: "cs_concurrent_test",
            status: "open",
            url: "https://checkout.stripe.test/concurrent",
          });
        },
      },
      async () => {
        try {
          const winner = fixture.request("/checkout", { method: "POST" });
          await requestStarted;
          const repeated = fixture.request("/checkout", { method: "POST" });
          expect((await repeated).status).toBe(409);
          releaseRequest();
          expect((await winner).status).toBe(200);
          expect(idempotencyKeys).toHaveLength(1);
          expect(
            fixture.database
              .query(
                `SELECT pending_checkout_session_id FROM organization_billing
             WHERE organization_id = ?`,
              )
              .get(organizationId),
          ).toEqual({ pending_checkout_session_id: "cs_concurrent_test" });
        } finally {
          releaseRequest();
        }
      },
    );
  });

  it("reconciles an indeterminate Checkout through its webhook", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      stripe_customer_id: "cus_original",
    });
    const customers: Array<string | null> = [];
    const idempotencyKeys: string[] = [];
    const checkoutClaimIds: Array<string | null> = [];
    const subscriptionClaimIds: Array<string | null> = [];
    let requestCount = 0;
    const stripe = async (call: FetchCall) => {
      const url = call.url;
      if (url.endsWith("/v1/checkout/sessions")) {
        requestCount += 1;
        idempotencyKeys.push(call.headers.get("Idempotency-Key") ?? "");
        const parameters = new URLSearchParams(call.body);
        customers.push(parameters.get("customer"));
        checkoutClaimIds.push(parameters.get("metadata[checkout_claim_id]"));
        subscriptionClaimIds.push(
          parameters.get("subscription_data[metadata][checkout_claim_id]"),
        );
        return Response.json(
          { error: { message: "Stripe temporarily unavailable" } },
          { status: 500 },
        );
      }
      if (url.endsWith("/v1/subscriptions/sub_indeterminate")) {
        return Response.json(
          subscriptionEvent(
            "unused_indeterminate",
            101,
            "active",
            1,
            "sub_indeterminate",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    };
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": stripe,
        "GET https://api.stripe.com/v1/subscriptions/sub_indeterminate": stripe,
      },
      async () => {
        const failed = await fixture.request("/checkout", { method: "POST" });
        expect(failed.status).toBe(502);
        const claim = fixture.database
          .query(
            `SELECT checkout_claim_id, checkout_claim_price_id
           FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId) as {
          checkout_claim_id: string;
          checkout_claim_price_id: string;
        };
        const claimId = claim.checkout_claim_id;
        expect(typeof claimId).toBe("string");
        expect(claim.checkout_claim_price_id).toBe(proPriceId);
        expect(checkoutClaimIds).toEqual([claimId]);
        expect(subscriptionClaimIds).toEqual([claimId]);

        const retried = await fixture.request("/checkout", { method: "POST" });
        expect(retried.status).toBe(409);
        expect(requestCount).toBe(1);

        const subscriptionCreated = subscriptionEvent(
          "evt_indeterminate_subscription",
          100,
          "active",
          1,
          "sub_indeterminate",
        );
        expect((await sendWebhook(fixture, subscriptionCreated)).status).toBe(
          200,
        );
        expect(
          fixture.database
            .query(
              `SELECT checkout_claim_id, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          checkout_claim_id: claimId,
          stripe_subscription_id: "sub_indeterminate",
        });

        const completed = {
          created: 101,
          data: {
            object: {
              client_reference_id: organizationId,
              id: "cs_indeterminate",
              metadata: {
                checkout_claim_id: claimId,
                organization_id: organizationId,
              },
              subscription: "sub_indeterminate",
            },
          },
          id: "evt_indeterminate_checkout",
          type: "checkout.session.completed",
        };
        expect((await sendWebhook(fixture, completed)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT checkout_claim_id, pending_checkout_session_id,
                    stripe_status, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          checkout_claim_id: null,
          pending_checkout_session_id: null,
          stripe_status: "active",
          stripe_subscription_id: "sub_indeterminate",
        });
        expect(idempotencyKeys).toHaveLength(1);
        expect(customers).toEqual(["cus_original"]);
      },
      { captureErrors: true },
    );
  });

  it("releases a Checkout claim after a definitive Stripe rejection", async () => {
    const fixture = createFixture();
    const idempotencyKeys: string[] = [];
    let requestCount = 0;
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async (
          call: FetchCall,
        ) => {
          requestCount += 1;
          idempotencyKeys.push(call.headers.get("Idempotency-Key") ?? "");
          if (requestCount === 1) {
            return Response.json(
              { error: { message: "Invalid Stripe price" } },
              { status: 400 },
            );
          }
          return Response.json({
            expires_at: Math.floor(Date.now() / 1_000) + 1_800,
            id: "cs_retry_success",
            status: "open",
            url: "https://checkout.stripe.test/retry",
          });
        },
      },
      async () => {
        const rejected = await fixture.request("/checkout", { method: "POST" });
        expect(rejected.status).toBe(502);
        expect(
          fixture.database
            .query(
              `SELECT checkout_claim_id FROM organization_billing
             WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ checkout_claim_id: null });
        const retried = await fixture.request("/checkout", { method: "POST" });
        expect(retried.status).toBe(200);
        expect(new Set(idempotencyKeys).size).toBe(2);
      },
      { captureErrors: true },
    );
  });

  it("rejects malformed successful Stripe responses", async () => {
    const fixture = createFixture();
    let responseBody: Record<string, unknown> = {
      id: "not-a-checkout-session",
    };
    await withFetch(
      {
        "POST https://api.stripe.com/v1/checkout/sessions": async () =>
          Response.json(responseBody),
      },
      async () => {
        const response = await fixture.request("/checkout", { method: "POST" });
        expect(response.status).toBe(502);
        expect((await response.json()) as unknown).toEqual({
          error: "Stripe returned a malformed Checkout session ID.",
        });

        responseBody = {
          expires_at: Math.floor(Date.now() / 1_000) + 1_800,
          id: "cs_missing_url",
          status: "open",
        };
        const missingUrlFixture = createFixture();
        const missingUrl = await missingUrlFixture.app.request(
          "/checkout",
          { method: "POST" },
          missingUrlFixture.bindings,
        );
        expect(missingUrl.status).toBe(502);
        expect((await missingUrl.json()) as unknown).toEqual({
          error: "Stripe did not return a checkout URL.",
        });
      },
      { captureErrors: true },
    );
  });

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
        await cancelOrganizationSubscription(fixture.bindings, organizationId),
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
          cancelOrganizationSubscription(fixture.bindings, organizationId),
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
          );
          await cancellationStarted;
          await expect(
            cancelOrganizationSubscription(fixture.bindings, organizationId),
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

  it("uses signed, idempotent, ordered webhooks as the entitlement source", async () => {
    const fixture = createFixture();
    const active = subscriptionEvent("evt_active", 100, "active", 3);
    let currentSubscription = active.data.object;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () =>
          Response.json(currentSubscription),
      },
      async () => {
        const first = await sendWebhook(fixture, active);
        expect(first.status).toBe(200);
        expect((await first.json()) as unknown).toEqual({ received: true });
        expect((await sendWebhook(fixture, active)).status).toBe(200);
        expect(
          fixture.database
            .query(
              `SELECT stripe_status, seat_quantity, stripe_event_created
             FROM organization_billing WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({
          seat_quantity: 3,
          stripe_event_created: 100,
          stripe_status: "active",
        });
        expect(
          fixture.database
            .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
            .get(),
        ).toEqual({ count: 1 });

        await sendWebhook(
          fixture,
          subscriptionEvent("evt_old", 99, "canceled", 3),
        );
        expect(
          fixture.database
            .query(
              `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ stripe_status: "active" });

        await sendWebhook(
          fixture,
          subscriptionEvent("evt_same_second_stale", 100, "canceled", 3),
        );
        expect(
          fixture.database
            .query(
              `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ stripe_status: "active" });

        const canceled = subscriptionEvent("evt_canceled", 101, "canceled", 3);
        currentSubscription = canceled.data.object;
        await sendWebhook(fixture, canceled);
        const summary = await fixture.request("/", undefined);
        expect(await summary.json()).toMatchObject({ plan: "free" });
      },
    );
  });

  it("prunes Stripe webhook receipts outside the replay window", async () => {
    const fixture = createFixture();
    fixture.database.exec(
      `INSERT INTO stripe_webhook_events
       (id, event_type, stripe_created, received_at, processed_at)
       VALUES
         ('evt_old_processed', 'invoice.paid', 1,
          '2026-06-01', '2026-06-01'),
         ('evt_old_unprocessed', 'invoice.paid', 2,
          '2026-06-01', NULL),
         ('evt_recent', 'invoice.paid', 3,
          '2026-08-20', '2026-08-20')`,
    );

    expect(
      await purgeStripeWebhookReceipts(fixture.bindings, "2026-07-01"),
    ).toBe(2);
    expect(
      fixture.database.query("SELECT id FROM stripe_webhook_events").all(),
    ).toEqual([{ id: "evt_recent" }]);
  });

  it("rejects missing, invalid, and stale webhook signatures", async () => {
    const fixture = createFixture();
    const event = subscriptionEvent("evt_bad_signature", 100, "active", 1);
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000);
    const staleTimestamp = timestamp - 301;
    const staleSignature = await webhookSignature(
      fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
      staleTimestamp,
      payload,
    );
    const requests = [
      new Request("https://api.test/", { body: payload, method: "POST" }),
      new Request("https://api.test/", {
        body: payload,
        headers: {
          "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)}`,
        },
        method: "POST",
      }),
      new Request("https://api.test/", {
        body: payload,
        headers: {
          "stripe-signature": `t=${staleTimestamp},v1=${staleSignature}`,
        },
        method: "POST",
      }),
    ];
    for (const request of requests) {
      expect(
        (await fixture.webhook.request(request, undefined, fixture.bindings))
          .status,
      ).toBe(400);
    }
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("stops reading oversized webhook payloads", async () => {
    const fixture = createFixture();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
    });
    const response = await fixture.webhook.request(
      new Request("https://api.test/", { body, method: "POST" }),
      undefined,
      fixture.bindings,
    );

    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
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

  it("asks Stripe to retry a duplicate webhook still in progress", async () => {
    const fixture = createFixture();
    const event = subscriptionEvent(
      "evt_duplicate_processing",
      100,
      "active",
      1,
    );
    let markFetchStarted = () => {};
    let releaseFetch = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscriptions/sub_test": async () => {
          fetchCount += 1;
          markFetchStarted();
          await fetchReleased;
          return Response.json(event.data.object);
        },
      },
      async () => {
        try {
          const firstResponse = sendWebhook(fixture, event);
          await fetchStarted;
          const duplicateResponse = await sendWebhook(fixture, event);
          expect(duplicateResponse.status).toBe(503);
          expect((await duplicateResponse.json()) as unknown).toEqual({
            error: "Webhook event is already being processed.",
          });
          releaseFetch();
          expect((await firstResponse).status).toBe(200);
          expect((await sendWebhook(fixture, event)).status).toBe(200);
          expect(fetchCount).toBe(1);
        } finally {
          releaseFetch();
        }
      },
    );
  });

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

  it("synchronizes Stripe quantity to active organization members", async () => {
    const fixture = createFixture();
    addMember(fixture.database, "user-2", organizationId);
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 1,
      stripe_customer_id: "cus_test",
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_test",
      stripe_subscription_item_id: "si_test",
    });
    const quantities: string[] = [];
    await withFetch(
      {
        "POST https://api.stripe.com/v1/subscription_items/si_test": async (
          call: FetchCall,
        ) => {
          expect(call.url).toContain("/v1/subscription_items/si_test");
          const quantity = new URLSearchParams(call.body).get("quantity");
          if (quantity) quantities.push(quantity);
          return Response.json({ id: "si_test", quantity: 2 });
        },
      },
      async () => {
        expect(
          await syncOrganizationSeats(fixture.bindings, organizationId),
        ).toBe(true);
        expect(quantities).toEqual(["2"]);
        expect(
          fixture.database
            .query(
              `SELECT seat_quantity FROM organization_billing
             WHERE organization_id = ?`,
            )
            .get(organizationId),
        ).toEqual({ seat_quantity: 2 });
      },
    );
  });

  it("serializes concurrent seat changes to the final member count", async () => {
    const fixture = createFixture();
    addMember(fixture.database, "user-2", organizationId);
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 1,
      stripe_customer_id: "cus_test",
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_id: "sub_test",
      stripe_subscription_item_id: "si_test",
    });
    let markFirstRequestStarted = () => {};
    let releaseFirstRequest = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const quantities: number[] = [];
    await withFetch(
      {
        "POST https://api.stripe.com/v1/subscription_items/si_test": async (
          call: FetchCall,
        ) => {
          const quantity = Number(
            new URLSearchParams(call.body).get("quantity"),
          );
          quantities.push(quantity);
          if (quantities.length === 1) {
            markFirstRequestStarted();
            await firstRequestReleased;
          }
          return Response.json({ id: "si_test", quantity });
        },
      },
      async () => {
        try {
          const firstSync = syncOrganizationSeats(
            fixture.bindings,
            organizationId,
          );
          await firstRequestStarted;
          addMember(fixture.database, "user-3", organizationId);
          const secondSync = syncOrganizationSeats(
            fixture.bindings,
            organizationId,
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
          releaseFirstRequest();
          expect(await Promise.all([firstSync, secondSync])).toEqual([
            true,
            true,
          ]);
          expect(quantities).toEqual([2, 3]);
          expect(
            fixture.database
              .query(
                `SELECT seat_quantity FROM organization_billing
             WHERE organization_id = ?`,
              )
              .get(organizationId),
          ).toEqual({ seat_quantity: 3 });
        } finally {
          releaseFirstRequest();
        }
      },
    );
  });

  it("rotates a bounded batch of subscription reconciliations", async () => {
    const fixture = createFixture();
    const now = new Date().toISOString();
    for (let index = 0; index < 30; index += 1) {
      const target =
        index < 3 ? `org_user-${index + 1}` : `org_reconcile-${index}`;
      if (index >= 3) {
        const userId = `reconcile-${index}`;
        seedUser(fixture.database, { createdAt: now, id: userId });
        seedOrganization(fixture.database, {
          createdAt: now,
          id: target,
          name: `Reconcile ${index}`,
          slug: `reconcile-${index}`,
        });
        addMember(fixture.database, userId, target);
      }
      insertBilling(fixture.database, target, {
        seat_quantity: 1,
        stripe_event_created: 1,
        stripe_price_id: proPriceId,
        stripe_status: "active",
        stripe_subscription_item_id: `si_${index}`,
        updated_at: now,
      });
    }

    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscription_items/si_*": async (
          call: FetchCall,
        ) => {
          const id = call.url.split("/").at(-1);
          return Response.json({ id, quantity: 1 });
        },
      },
      async () => {
        await reconcileSubscriptionSeats(fixture.bindings);
        expect(reconciledCount(fixture.database)).toEqual({ count: 25 });
        await reconcileSubscriptionSeats(fixture.bindings);
        expect(reconciledCount(fixture.database)).toEqual({ count: 30 });
      },
    );
  });

  it("repairs Stripe seat drift even when the cached quantity matches", async () => {
    const fixture = createFixture();
    insertBilling(fixture.database, organizationId, {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: proPriceId,
      stripe_status: "active",
      stripe_subscription_item_id: "si_drift",
    });
    const requests: Array<{ method: string; quantity: string | null }> = [];
    const stripe = async (call: FetchCall) => {
      requests.push({
        method: call.method,
        quantity: new URLSearchParams(call.body).get("quantity"),
      });
      return Response.json({
        id: "si_drift",
        quantity: call.method === "POST" ? 1 : 2,
      });
    };
    await withFetch(
      {
        "GET https://api.stripe.com/v1/subscription_items/si_drift": stripe,
        "POST https://api.stripe.com/v1/subscription_items/si_drift": stripe,
      },
      async () => {
        await reconcileSubscriptionSeats(fixture.bindings);
        expect(requests).toEqual([
          { method: "GET", quantity: null },
          { method: "POST", quantity: "1" },
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
        await Bun.sleep(2);
        subscription = subscriptionEvent(
          "evt_lapsed_again",
          102,
          "canceled",
          1,
        );
        expect((await sendWebhook(fixture, subscription)).status).toBe(200);
        expect(paidEndedAt()).toBe(lapsedAt);

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

function createFixture(organizationRole = "owner") {
  const database = createTestDatabase();
  for (const id of ["user-1", "user-2", "user-3"])
    seedAccount(database, { createdAt: new Date().toISOString(), id });
  const bindings = testBindings({
    AUTH_EMAIL_FROM: "security@auth.balebase.test",
    BETTER_AUTH_URL: "https://api.balebase.test",
    CORS_ORIGIN: "https://app.balebase.test",
    DB: toD1(database),
    INBOUND_EMAIL_DOMAIN: "inbox.balebase.test",
    STRIPE_PRO_LEGACY_PRICE_IDS: "",
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  });
  const app = testApp(
    { "/": billing },
    {
      email: "user-1@example.com",
      organizationId,
      organizationRole,
      userId: "user-1",
    },
  );
  const webhook = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  webhook.post("/", handleStripeWebhook);
  return {
    app,
    bindings,
    database,
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
    webhook,
  };
}

function subscriptionEvent(
  id: string,
  created: number,
  status: string,
  quantity: number,
  subscriptionId = "sub_test",
  priceId = proPriceId,
) {
  return {
    created,
    data: {
      object: {
        cancel_at: null,
        cancel_at_period_end: false,
        customer: "cus_test",
        id: subscriptionId,
        items: {
          data: [
            {
              current_period_end: 1_800_000_000,
              id:
                subscriptionId === "sub_test"
                  ? "si_test"
                  : `si_${subscriptionId}`,
              price: { id: priceId },
              quantity,
            },
          ],
        },
        metadata: { organization_id: organizationId },
        status,
      },
    },
    id,
    type: `customer.subscription.${status === "canceled" ? "deleted" : "updated"}`,
  };
}

async function sendWebhook(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  event: {
    created: number;
    data: { object: unknown };
    id: string;
    type: string;
  },
) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await webhookSignature(
    fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
    timestamp,
    payload,
  );
  return fixture.webhook.request(
    "/",
    {
      body: payload,
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      method: "POST",
    },
    fixture.bindings,
  );
}

async function webhookSignature(
  secret: string,
  timestamp: number,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addMember(database: Database, userId: string, target: string) {
  seedMember(database, {
    createdAt: new Date().toISOString(),
    organizationId: target,
    userId,
  });
}

function insertAudit(
  database: Database,
  id: string,
  target: string,
  createdAt: string,
) {
  database
    .query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, ?, 'Example form', '{"version":1,"sections":[]}', '{}',
               'completed', 'user-1', ?, ?)`,
    )
    .run(id, target, createdAt, createdAt);
}

function reserveCheckout(database: Database, sessionId: string) {
  database
    .query(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?,
           pending_checkout_url = 'https://checkout.stripe.test/pending',
           pending_checkout_expires_at = 2000000000
       WHERE organization_id = ?`,
    )
    .run(sessionId, organizationId);
}

function insertStalePendingCheckout(database: Database, sessionId: string) {
  insertBilling(database, organizationId, {
    pending_checkout_expires_at: 1,
    pending_checkout_session_id: sessionId,
    pending_checkout_url: "https://checkout.stripe.test/stale",
  });
}

function reconciledCount(database: Database) {
  return database
    .query(
      `SELECT COUNT(*) AS count FROM organization_billing
       WHERE last_reconciled_at IS NOT NULL`,
    )
    .get();
}
