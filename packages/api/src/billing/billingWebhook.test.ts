import { describe, expect, it } from "bun:test";
import {
  createFixture,
  organizationId,
  sendWebhook,
  subscriptionEvent,
  webhookSignature,
} from "../testing/billingFixture";
import { withFetch } from "../testing/http";
import { purgeStripeWebhookReceipts } from "./billingWebhook";

describe("billing webhook", () => {
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
});
