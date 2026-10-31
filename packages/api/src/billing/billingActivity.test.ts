import { describe, expect, it } from "bun:test";
import { findActivity } from "../shared/activity";
import {
  createFixture,
  organizationId,
  proPriceId,
} from "../testing/billingFixture";
import { type FetchCall, withFetch } from "../testing/http";
import { storePendingCheckout } from "./billingCheckout";

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
