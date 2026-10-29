import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  createFixture,
  organizationId,
  proPriceId,
} from "../testing/billingFixture";
import { queryHooks, toD1 } from "../testing/d1";
import { type FetchCall, withFetch } from "../testing/http";
import {
  insertBilling,
  seedMember,
  seedOrganization,
  seedUser,
} from "../testing/seed";
import {
  reconcileSubscriptionSeats,
  syncOrganizationSeats,
} from "./billingSeats";

describe("billing seats", () => {
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
    // The first sync claims the subscription's lock; the second's claim is
    // refused, so it waits for the lock.
    const hooks = queryHooks();
    const secondSyncWaiting = Promise.withResolvers<void>();
    let claims = 0;
    hooks.after(
      "INSERT INTO stripe_subscription_sync_locks",
      () => {
        claims += 1;
        if (claims === 2) secondSyncWaiting.resolve();
      },
      { times: 2 },
    );
    const bindings = { ...fixture.bindings, DB: toD1(fixture.database, hooks) };
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
          const firstSync = syncOrganizationSeats(bindings, organizationId);
          await firstRequestStarted;
          addMember(fixture.database, "user-3", organizationId);
          const secondSync = syncOrganizationSeats(bindings, organizationId);
          await secondSyncWaiting.promise;
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
});

function addMember(database: Database, userId: string, target: string) {
  seedMember(database, {
    createdAt: new Date().toISOString(),
    organizationId: target,
    userId,
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
