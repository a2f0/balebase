import { describe, expect, it } from "bun:test";
import {
  createFixture,
  insertStalePendingCheckout,
  organizationId,
  proPriceId,
  sendWebhook,
  subscriptionEvent,
} from "../testing/billingFixture";
import { type FetchCall, withFetch } from "../testing/http";
import { insertBilling } from "../testing/seed";

describe("billing checkout", () => {
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
});
